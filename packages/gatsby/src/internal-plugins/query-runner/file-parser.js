// @flow
const fs = require(`fs-extra`)
const crypto = require(`crypto`)
const _ = require(`lodash`)

// Traverse is a es6 module...
import traverse from "@babel/traverse"
const getGraphQLTag = require(`babel-plugin-remove-graphql-queries`)
  .getGraphQLTag
const report = require(`gatsby-cli/lib/reporter`)

import type { DocumentNode, DefinitionNode } from "graphql"
import { babelParseToAst } from "../../utils/babel-parse-to-ast"

const apiRunnerNode = require(`../../utils/api-runner-node`)
const { boundActionCreators } = require(`../../redux/actions`)

/**
 * Add autogenerated query name if it wasn't defined by user.
 */
const generateQueryName = ({ def, hash, file }) => {
  if (!def.name || !def.name.value) {
    def.name = {
      value: `${_.camelCase(file)}${hash}`,
      kind: `Name`,
    }
  }
  return def
}

const warnForUnknownQueryVariable = (varName, file, usageFunction) =>
  report.warn(
    `\nWe were unable to find the declaration of variable "${varName}", which you passed as the "query" prop into the ${usageFunction} declaration in "${file}".

Perhaps the variable name has a typo?

Also note that we are currently unable to use queries defined in files other than the file where the ${usageFunction} is defined. If you're attempting to import the query, please move it into "${file}". If being able to import queries from another file is an important capability for you, we invite your help fixing it.\n`
  )

async function parseToAst(filePath, fileStr) {
  let ast

  // Preprocess and attempt to parse source; return an AST if we can, log an
  // error if we can't.
  const transpiled = await apiRunnerNode(`preprocessSource`, {
    filename: filePath,
    contents: fileStr,
  })
  if (transpiled && transpiled.length) {
    for (const item of transpiled) {
      try {
        const tmp = babelParseToAst(item, filePath)
        ast = tmp
        break
      } catch (error) {
        report.error(error)
        boundActionCreators.queryExtractionGraphQLError({
          componentPath: filePath,
        })
        continue
      }
    }
    if (ast === undefined) {
      report.error(`Failed to parse preprocessed file ${filePath}`)
      boundActionCreators.queryExtractionGraphQLError({
        componentPath: filePath,
      })

      return null
    }
  } else {
    try {
      ast = babelParseToAst(fileStr, filePath)
    } catch (error) {
      boundActionCreators.queryExtractionBabelError({
        componentPath: filePath,
        error,
      })
      report.error(
        `There was a problem parsing "${filePath}"; any GraphQL ` +
          `fragments or queries in this file were not processed. \n` +
          `This may indicate a syntax error in the code, or it may be a file type ` +
          `that Gatsby does not know how to parse.`
      )

      return null
    }
  }

  return ast
}

const warnForGlobalTag = file =>
  report.warn(
    `Using the global \`graphql\` tag is deprecated, and will not be supported in v3.\n` +
      `Import it instead like:  import { graphql } from 'gatsby' in file:\n` +
      file
  )

async function findGraphQLTags(file, text): Promise<Array<DefinitionNode>> {
  return new Promise((resolve, reject) => {
    parseToAst(file, text)
      .then(ast => {
        let queries = []
        if (!ast) {
          resolve(queries)
          return
        }

        /**
         * A map of graphql documents to unique locations.
         *
         * A graphql document's unique location is made of:
         *
         *  - the location of the graphql template literal that contains the document, and
         *  - the document's location within the graphql template literal
         *
         * This is used to prevent returning duplicated documents.
         */
        const documentLocations = new WeakMap()

        const extractStaticQuery = (
          taggedTemplateExpressPath,
          isHook = false
        ) => {
          const { ast: gqlAst, text, hash, isGlobal } = getGraphQLTag(
            taggedTemplateExpressPath
          )
          if (!gqlAst) return

          if (isGlobal) warnForGlobalTag(file)

          gqlAst.definitions.forEach(def => {
            documentLocations.set(
              def,
              `${taggedTemplateExpressPath.node.start}-${def.loc.start}`
            )
            generateQueryName({
              def,
              hash,
              file,
            })
          })

          const definitions = [...gqlAst.definitions].map(d => {
            d.isStaticQuery = true
            d.isHook = isHook
            d.text = text
            d.hash = hash
            return d
          })

          queries.push(...definitions)
        }

        // Look for queries in <StaticQuery /> elements.
        traverse(ast, {
          JSXElement(path) {
            if (path.node.openingElement.name.name !== `StaticQuery`) {
              return
            }

            // astexplorer.com link I (@kyleamathews) used when prototyping this algorithm
            // https://astexplorer.net/#/gist/ab5d71c0f08f287fbb840bf1dd8b85ff/2f188345d8e5a4152fe7c96f0d52dbcc6e9da466
            path.traverse({
              JSXAttribute(jsxPath) {
                if (jsxPath.node.name.name !== `query`) {
                  return
                }
                jsxPath.traverse({
                  // Assume the query is inline in the component and extract that.
                  TaggedTemplateExpression(templatePath) {
                    extractStaticQuery(templatePath)
                  },
                  // Also see if it's a variable that's passed in as a prop
                  // and if it is, go find it.
                  Identifier(identifierPath) {
                    if (identifierPath.node.name !== `graphql`) {
                      const varName = identifierPath.node.name
                      let found = false
                      traverse(ast, {
                        VariableDeclarator(varPath) {
                          if (
                            varPath.node.id.name === varName &&
                            varPath.node.init.type ===
                              `TaggedTemplateExpression`
                          ) {
                            varPath.traverse({
                              TaggedTemplateExpression(templatePath) {
                                found = true
                                extractStaticQuery(templatePath)
                              },
                            })
                          }
                        },
                      })
                      if (!found) {
                        warnForUnknownQueryVariable(
                          varName,
                          file,
                          `<StaticQuery>`
                        )
                      }
                    }
                  },
                })
              },
            })
            return
          },
        })

        // Look for queries in useStaticQuery hooks.
        traverse(ast, {
          CallExpression(hookPath) {
            if (
              hookPath.node.callee.name !== `useStaticQuery` ||
              !hookPath.get(`callee`).referencesImport(`gatsby`)
            ) {
              return
            }

            hookPath.traverse({
              // Assume the query is inline in the component and extract that.
              TaggedTemplateExpression(templatePath) {
                extractStaticQuery(templatePath, true)
              },
              // // Also see if it's a variable that's passed in as a prop
              // // and if it is, go find it.
              Identifier(identifierPath) {
                if (
                  identifierPath.node.name !== `graphql` &&
                  identifierPath.node.name !== `useStaticQuery`
                ) {
                  const varName = identifierPath.node.name
                  let found = false
                  traverse(ast, {
                    VariableDeclarator(varPath) {
                      if (
                        varPath.node.id.name === varName &&
                        varPath.node.init.type === `TaggedTemplateExpression`
                      ) {
                        varPath.traverse({
                          TaggedTemplateExpression(templatePath) {
                            found = true
                            extractStaticQuery(templatePath, true)
                          },
                        })
                      }
                    },
                  })
                  if (!found) {
                    warnForUnknownQueryVariable(varName, file, `useStaticQuery`)
                  }
                }
              },
            })
          },
        })

        // Look for exported page queries
        traverse(ast, {
          ExportNamedDeclaration(path, state) {
            path.traverse({
              TaggedTemplateExpression(innerPath) {
                const { ast: gqlAst, isGlobal, hash } = getGraphQLTag(innerPath)
                if (!gqlAst) return

                if (isGlobal) warnForGlobalTag(file)

                gqlAst.definitions.forEach(def => {
                  documentLocations.set(
                    def,
                    `${innerPath.node.start}-${def.loc.start}`
                  )
                  generateQueryName({
                    def,
                    hash,
                    file,
                  })
                })

                queries.push(...gqlAst.definitions)
              },
            })
          },
        })

        // Remove duplicate queries
        const uniqueQueries = _.uniqBy(queries, q => documentLocations.get(q))

        resolve(uniqueQueries)
      })
      .catch(reject)
  })
}

const cache = {}

export default class FileParser {
  async parseFile(file: string): Promise<?DocumentNode> {
    let text
    try {
      text = await fs.readFile(file, `utf8`)
    } catch (err) {
      report.error(`There was a problem reading the file: ${file}`, err)
      boundActionCreators.queryExtractionGraphQLError({
        componentPath: file,
      })
      return null
    }

    if (text.indexOf(`graphql`) === -1) return null
    const hash = crypto
      .createHash(`md5`)
      .update(file)
      .update(text)
      .digest(`hex`)

    try {
      let astDefinitions =
        cache[hash] || (cache[hash] = await findGraphQLTags(file, text))

      // If any AST definitions were extracted, report success.
      // This can mean there is none or there was a babel error when
      // we tried to extract the graphql AST.
      if (astDefinitions.length > 0) {
        boundActionCreators.queryExtractedBabelSuccess({
          componentPath: file,
        })
      }

      return astDefinitions.length
        ? {
            kind: `Document`,
            definitions: astDefinitions,
          }
        : null
    } catch (err) {
      report.error(
        `There was a problem parsing the GraphQL query in file: ${file}`,
        err
      )
      boundActionCreators.queryExtractionGraphQLError({
        componentPath: file,
      })
      return null
    }
  }

  async parseFiles(files: Array<string>): Promise<Map<string, DocumentNode>> {
    const documents = new Map()

    return Promise.all(
      files.map(file =>
        this.parseFile(file).then(doc => {
          if (!doc) return
          documents.set(file, doc)
        })
      )
    ).then(() => documents)
  }
}
