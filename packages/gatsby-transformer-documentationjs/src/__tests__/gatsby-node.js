import groupBy from "lodash/groupBy"
import path from "path"
import gatsbyNode from "../gatsby-node"

describe(`transformer-react-doc-gen: onCreateNode`, () => {
  let createdNodes, updatedNodes
  const createNodeId = jest.fn(id => id)
  const createContentDigest = jest.fn().mockReturnValue(`content-digest`)

  const node = {
    id: `node_1`,
    children: [],
    absolutePath: path.join(__dirname, `fixtures`, `code.js`),
    internal: {
      mediaType: `application/javascript`,
      type: `File`,
    },
  }

  const actions = {
    createNode: jest.fn(n => createdNodes.push(n)),
    createParentChildLink: jest.fn(n => {
      updatedNodes.push(n)
      const parentNode = createdNodes.find(node => node.id === n.parent.id)
      if (parentNode) {
        parentNode.children.push(n.child.id)
      } else if (n.parent.id !== `node_1`) {
        throw new Error(`Creating parent-child link for not existing parent`)
      }
    }),
  }

  const run = async (node = node, opts = {}) => {
    createdNodes = []
    updatedNodes = []
    await gatsbyNode.onCreateNode(
      {
        node,
        actions,
        createNodeId,
        createContentDigest,
      },
      opts
    )
  }

  beforeAll(async () => {
    await run(node)
  })

  describe(`Simple example`, () => {
    it(`creates doc json apple node`, () => {
      const appleNode = createdNodes.find(node => node.name === `apple`)
      expect(appleNode).toBeDefined()
    })

    it(`should extract out a description, params, and examples`, () => {
      const appleNode = createdNodes.find(node => node.name === `apple`)

      expect(appleNode.examples.length).toBe(1)
      expect(appleNode.examples[0]).toMatchSnapshot(`example`)

      const appleDescriptionNode = createdNodes.find(
        node => node.id === appleNode.description___NODE
      )

      expect(appleDescriptionNode).toBeDefined()
      expect(appleDescriptionNode.internal.content).toMatchSnapshot(
        `description content`
      )

      const paramNode = createdNodes.find(
        node => node.id === appleNode.params___NODE[0]
      )

      expect(paramNode).toBeDefined()
      expect(paramNode.name).toMatchSnapshot(`param name`)

      const paramDescriptionNode = createdNodes.find(
        node => node.id === paramNode.description___NODE
      )

      expect(paramDescriptionNode).toBeDefined()
      expect(paramDescriptionNode.internal.content).toMatchSnapshot(
        `param description`
      )
    })

    it(`should extract code and docs location`, () => {
      const appleNode = createdNodes.find(node => node.name === `apple`)

      expect(appleNode.docsLocation).toBeDefined()
      expect(appleNode.docsLocation).toEqual(
        expect.objectContaining({
          start: expect.objectContaining({
            line: 1,
          }),
          end: expect.objectContaining({
            line: 7,
          }),
        })
      )

      expect(appleNode.codeLocation).toBeDefined()
      expect(appleNode.codeLocation).toEqual(
        expect.objectContaining({
          start: expect.objectContaining({
            line: 8,
          }),
          end: expect.objectContaining({
            line: 10,
          }),
        })
      )
    })
  })

  describe(`Complex example`, () => {
    let callbackNode, typedefNode

    it(`should create top-level node for callback`, () => {
      callbackNode = createdNodes.find(
        node =>
          node.name === `CallbackType` &&
          node.kind === `typedef` &&
          node.parent === `node_1`
      )
      expect(callbackNode).toBeDefined()
    })

    describe(`should handle typedefs`, () => {
      it(`should create top-level node for typedef`, () => {
        typedefNode = createdNodes.find(
          node =>
            node.name === `ObjectType` &&
            node.kind === `typedef` &&
            node.parent === `node_1`
        )
        expect(typedefNode).toBeDefined()
      })

      let readyNode, nestedNode

      it(`should have property nodes for typedef`, () => {
        expect(typedefNode.properties___NODE).toBeDefined()
        expect(typedefNode.properties___NODE.length).toBe(2)
        ;[readyNode, nestedNode] = typedefNode.properties___NODE.map(paramID =>
          createdNodes.find(node => node.id === paramID)
        )
      })

      it(`should handle type applications`, () => {
        expect(readyNode).toMatchSnapshot()
      })

      let nestedFooNode, nestedOptionalNode, nestedCallbackNode

      it(`should have second param as nested object`, () => {
        expect(nestedNode.name).toBe(`nested`)
        expect(nestedNode.properties___NODE).toBeDefined()
        expect(nestedNode.properties___NODE.length).toBe(3)
        ;[
          nestedFooNode,
          nestedOptionalNode,
          nestedCallbackNode,
        ] = nestedNode.properties___NODE.map(paramID =>
          createdNodes.find(node => node.id === paramID)
        )
      })

      it(`should strip prefixes from nested nodes`, () => {
        expect(nestedFooNode.name).not.toContain(`nested`)
        expect(nestedFooNode.name).toEqual(`foo`)
      })

      it(`should handle optional types`, () => {
        expect(nestedOptionalNode.name).toEqual(`optional`)
        expect(nestedOptionalNode.optional).toEqual(true)
        expect(nestedOptionalNode.type).toEqual(
          expect.objectContaining({
            name: `number`,
            type: `NameExpression`,
          })
        )
      })

      it(`should handle typedefs in nested properties`, () => {
        expect(nestedCallbackNode.name).toEqual(`callback`)
        expect(nestedCallbackNode.optional).toEqual(false)
        expect(nestedCallbackNode.type).toEqual(
          expect.objectContaining({
            name: `CallbackType`,
            type: `NameExpression`,
            typeDef___NODE: callbackNode.id,
          })
        )
      })
    })

    describe(`should handle members`, () => {
      let complexNode, memberNode
      beforeAll(() => {
        complexNode = createdNodes.find(
          node => node.name === `complex` && node.parent === `node_1`
        )
      })

      it(`should create top-level node for complex type`, () => {
        expect(complexNode).toBeDefined()
      })

      it(`should have link from complex node to its members`, () => {
        expect(complexNode.members).toBeDefined()
        expect(complexNode.members.static___NODE).toBeDefined()
        expect(complexNode.members.static___NODE.length).toBe(1)

        memberNode = createdNodes.find(
          node => node.id === complexNode.members.static___NODE[0]
        )
        expect(memberNode).toBeDefined()
        expect(memberNode.parent).toEqual(complexNode.id)
      })

      it(`should handle type unions`, () => {
        expect(memberNode.type).toMatchSnapshot()
      })

      it(`should link to type to type definition`, () => {
        const typeElement = memberNode.type.elements.find(
          type => type.name === `ObjectType`
        )
        expect(typeElement.typeDef___NODE).toBe(typedefNode.id)
      })
    })
  })

  describe(`Sanity checks`, () => {
    it(`should extract create description nodes with markdown types`, () => {
      let types = groupBy(createdNodes, `internal.type`)
      expect(
        types.DocumentationJSComponentDescription.every(
          d => d.internal.mediaType === `text/markdown`
        )
      ).toBe(true)
    })

    it(`creates parent nodes before children`, () => {
      const seenNodes = []
      createdNodes.forEach(node => {
        seenNodes.push(node.id)

        node.children.forEach(childID => {
          expect(seenNodes.includes(childID)).not.toBe(true)
        })
      })
    })

    it(`should only process javascript File nodes`, async () => {
      await run({ internal: { mediaType: `text/x-foo` } })
      expect(createdNodes.length).toBe(0)

      await run({ internal: { mediaType: `application/javascript` } })
      expect(createdNodes.length).toBe(0)

      await run(node)
      expect(createdNodes.length).toBeGreaterThan(0)
    })
  })
})
