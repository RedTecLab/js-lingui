import fs from "fs"
import fsPath from "path"
import mkdirp from "mkdirp"
import generate from "babel-generator"
import { getConfig } from "@lingui/conf"

// Map of messages
const MESSAGES = Symbol("I18nMessages")

// We need to remember all processed nodes. When JSX expressions are
// replaced with CallExpressions, all children are traversed for each CallExpression.
// Then, i18n._ methods are visited multiple times for each parent CallExpression.
const VISITED = Symbol("I18nVisited")

function addMessage(path, messages, { id, defaults, origin, ...props }) {
  if (messages.has(id)) {
    const message = messages.get(id)

    // only set/check default language when it's defined.
    if (message.defaults && defaults && message.defaults !== defaults) {
      throw path.buildCodeFrameError(
        "Different defaults for the same message ID."
      )
    } else {
      if (defaults) {
        message.defaults = defaults
      }

      ;[].push.apply(message.origin, origin)
    }
  } else {
    messages.set(id, { ...props, defaults, origin })
  }
}

export default function({ types: t }) {
  let localTransComponentName
  let localTransWithHtmlComponentName

  const opts = getConfig()
  const optsBaseDir = opts.rootDir

  function isTransComponent(node) {
    return (
      t.isJSXElement(node) &&
      t.isJSXIdentifier(node.openingElement.name, {
        name: localTransComponentName
      })
    )
  }

  function isTransWithHtmlComponent(node) {
    return (
      t.isJSXElement(node) &&
      t.isJSXIdentifier(node.openingElement.name, {
        name: localTransWithHtmlComponentName
      })
    )
  }

  const isNoopMethod = node => t.isIdentifier(node, { name: "i18nMark" })
  const isI18nMethod = node =>
    t.isMemberExpression(node) &&
    t.isIdentifier(node.object, { name: "i18n" }) &&
    t.isIdentifier(node.property, { name: "_" })

  function collectMessage(path, file, props) {
    const messages = file.get(MESSAGES)

    const filename = fsPath
      .relative(optsBaseDir, file.opts.filename)
      .replace(/\\/g, "/")
    const line = path.node.loc ? path.node.loc.start.line : null
    props.origin = [[filename, line]]

    addMessage(path, messages, props)
  }

  return {
    visitor: {
      // Get the local name of Trans component. Usually it's just `Trans`, but
      // it might be different when the import is aliased:
      // import { Trans as T } from '@lingui/react';
      ImportDeclaration(path) {
        const { node } = path

        const moduleName = node.source.value
        if (
          !Array.includes(
            [
              "@lingui/react",
              "@lingui/macro",
              "@lingui/core",
              "views/components/utils/TransWithHtml"
            ],
            moduleName
          )
        )
          return

        const importDeclarations = {}
        if (
          moduleName === "@lingui/react" ||
          moduleName === "@lingui/macro" ||
          moduleName === "views/components/utils/TransWithHtml"
        ) {
          node.specifiers.forEach(specifier => {
            if (specifier.type !== "ImportDefaultSpecifier") {
              importDeclarations[specifier.imported.name] = specifier.local.name
            } else {
              importDeclarations[specifier.local.name] = specifier.local.name
            }
          })

          // Trans import might be missing if there's just Plural or similar macro.
          // If there's no alias, consider it was imported as Trans.
          localTransComponentName = importDeclarations["Trans"] || "Trans"

          localTransWithHtmlComponentName =
            importDeclarations["TransWithHtml"] || "TransWithHtml"
        }

        // Remove imports of i18nMark identity
        node.specifiers = node.specifiers.filter(specifier => {
          if (specifier.imported) {
            return specifier.imported.name !== "i18nMark"
          }
        })

        if (!node.specifiers.length) {
          path.remove()
        }
      },

      // Extract translation from <Trans /> component.
      JSXElement(path, { file }) {
        const { node } = path
        if (
          (!localTransComponentName && !localTransWithHtmlComponentName) ||
          (!isTransComponent(node) && !isTransWithHtmlComponent(node))
        )
          return

        const attrs = node.openingElement.attributes || []

        const props = attrs.reduce((acc, item) => {
          const key = item.name.name
          if (key === "id" || key === "defaults" || key === "description") {
            if (item.value.value) {
              acc[key] = item.value.value
            } else if (
              item.value.expression &&
              t.isStringLiteral(item.value.expression)
            ) {
              acc[key] = item.value.expression.value
            }
          }
          return acc
        }, {})

        if (!props.id) {
          // <Trans id={message} /> is valid, don't raise warning
          const idProp = attrs.filter(item => item.name.name === "id")[0]
          if (idProp === undefined || t.isLiteral(props.id)) {
            console.warn("Missing message ID, skipping.")
            console.warn(generate(node).code)
          }
          return
        }

        collectMessage(path, file, props)
      },

      // Extract translation from i18n._ call
      CallExpression(path, { file }) {
        const { node } = path
        const visited = file.get(VISITED)

        if (
          // we already visited this node
          visited.has(node.callee) ||
          // nothing to extract
          (!isI18nMethod(node.callee) && !isNoopMethod(node.callee))
        ) {
          return
        }

        visited.add(node.callee)

        if (
          isNoopMethod(node.callee) &&
          !t.isStringLiteral(node.arguments[0])
        ) {
          console.warn("Only string literals are allowed in i18nMark.")
          return
        }

        const attrs =
          node.arguments[2] && node.arguments[2].properties
            ? node.arguments[2].properties
            : []

        const idArg = node.arguments[0]
        const id = idArg && idArg.value
        if (!id) {
          // i18n._(message) is valid, don't raise warning
          if (idArg === undefined || t.isLiteral(idArg)) {
            console.warn("Missing message ID, skipping.")
            console.warn(generate(node).code)
          }

          return
        }

        const props = attrs.reduce(
          (acc, item) => {
            const key = item.key.name
            if (key === "defaults") acc[key] = item.value.value
            return acc
          },
          { id }
        )

        collectMessage(path, file, props)

        if (isNoopMethod(node.callee)) {
          const translation = node.arguments[0]
          path.replaceWith(t.stringLiteral(translation.value))
        }
      },

      // Extract message descriptors
      ObjectExpression(path, { file }) {
        const visited = file.get(VISITED)

        const comment =
          path.node.leadingComments &&
          path.node.leadingComments.filter(node =>
            node.value.match(/^\s*i18n/)
          )[0]

        if (!comment || visited.has(path.node)) {
          return
        }

        visited.add(path.node)

        const props = {}

        const description = comment.value.replace(/\s*i18n:?\s*/, "").trim()
        if (description) props.description = description

        const copyProps = ["id", "defaults"]
        path.node.properties
          .filter(({ key }) => copyProps.indexOf(key.name) !== -1)
          .forEach(({ key, value }) => {
            props[key.name] = value.value
          })

        collectMessage(path, file, props)
      }
    },

    pre(file) {
      localTransComponentName = null

      // Ignore else path for now. Collision is possible if other plugin is
      // using the same Symbol('I18nMessages').
      // istanbul ignore else
      if (!file.has(MESSAGES)) {
        file.set(MESSAGES, new Map())
      }

      file.set(VISITED, new WeakSet())
    },

    post(file) {
      /* Write catalog to directory `localeDir`/_build/`path.to.file`/`filename`.json
       * e.g: if file is src/components/App.js (relative to package.json), then
       * catalog will be in locale/_build/src/components/App.json
       */
      const localeDir = this.opts.localeDir || opts.localeDir
      const { filename } = file.opts
      const baseDir = fsPath.dirname(fsPath.relative(optsBaseDir, filename))
      const targetDir = fsPath.join(localeDir, "_build", baseDir)

      const messages = file.get(MESSAGES)
      const catalog = {}
      const baseName = fsPath.basename(filename)
      const catalogFilename = fsPath.join(targetDir, `${baseName}.json`)

      mkdirp.sync(targetDir)

      // no messages, skip file
      if (!messages.size) {
        // clean any existing catalog
        if (fs.existsSync(catalogFilename)) {
          fs.writeFileSync(catalogFilename, JSON.stringify({}))
        }

        return
      }

      messages.forEach((value, key) => {
        catalog[key] = value
      })

      fs.writeFileSync(catalogFilename, JSON.stringify(catalog, null, 2))
    }
  }
}
