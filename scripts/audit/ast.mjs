import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/** Candidates are evidence for review, never automatic declarations that product code is broken. */
export function scanAst(root, contracts) {
  const files = [], findings = [], inventory = []
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(p)
    }
  }
  walk(path.join(root, 'src'))
  const units = files.map(file => ({ file: path.relative(root, file).replaceAll('\\', '/'), ast: ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true) }))
  const calls = new Map()
  const callbackUses = new Set()
  const visit = (node, fn) => { fn(node); ts.forEachChild(node, n => visit(n, fn)) }
  const add = (unit, node, rule, message, confidence = 'review') => findings.push({ rule, confidence, file: unit.file, line: unit.ast.getLineAndCharacterOfPosition(node.getStart(unit.ast)).line + 1, message })
  for (const u of units) {
    const imports = new Map()
    for (const st of u.ast.statements) {
      if (!ts.isImportDeclaration(st) || st.importClause?.isTypeOnly) continue
      for (const s of st.importClause?.namedBindings?.elements ?? []) if (!s.isTypeOnly) imports.set(s.name.text, s.propertyName?.text ?? s.name.text)
    }
    let chart = false, mono = imports.has('useMonoTheme')
    visit(u.ast, n => {
      if (ts.isIdentifier(n) && (ts.isJsxExpression(n.parent) || (ts.isCallExpression(n.parent) && n.parent.arguments.includes(n)))) callbackUses.add(imports.get(n.text) ?? n.text)
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const name = imports.get(n.expression.text) ?? n.expression.text
        calls.set(name, (calls.get(name) ?? 0) + 1)
      }
      if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && ['svg', 'canvas'].includes(n.tagName.getText(u.ast))) chart = true
      if (mono && ts.isJsxAttribute(n) && ['opacity', 'strokeOpacity', 'fillOpacity'].includes(n.name.getText(u.ast))) {
        // A coloured-theme-only branch is not a mono leak.
        for (let p = n.parent; p; p = p.parent) {
          if (ts.isConditionalExpression(p) && p.condition.getText(u.ast) === 'mono' && n.pos >= p.whenFalse.pos && n.end <= p.whenFalse.end) return
        }
        const exp = n.initializer && (ts.isJsxExpression(n.initializer) ? n.initializer.expression : n.initializer)
        if (!exp) return
        // mono ? 1 : alpha is explicitly guarded. Other conditions need render evidence.
        if (ts.isConditionalExpression(exp) && /\bmono\b/.test(exp.condition.getText(u.ast)) && exp.whenTrue.getText(u.ast) === '1') return
        const nums = []
        visit(exp, x => { if (ts.isNumericLiteral(x) || ts.isStringLiteral(x)) { const v = Number(x.text); if (v > 0 && v < 1) nums.push(v) } })
        if (nums.length) add(u, n, 'mono.opacity', 'mono感知组件保留非二值透明度；核对分支及祖先合成，不以无彩色判通过')
      }
      if ((ts.isArrowFunction(n) || ts.isFunctionDeclaration(n)) && n.body) {
        const name = n.name?.text ?? (ts.isVariableDeclaration(n.parent) ? n.parent.name.getText(u.ast) : '')
        if (!/^(handle|submit|add|create|import)/.test(name)) return
        const names = new Set()
        const direct = x => {
          if (x !== n.body && ts.isFunctionLike(x)) return
          if (ts.isCallExpression(x)) names.add(x.expression.getText(u.ast))
          ts.forEachChild(x, direct)
        }
        direct(n.body)
        if (names.has('setActiveId') && names.has('setDraft') && ![...names].some(x => /flushCurrentDraft|saveCurrentDraft/.test(x))) {
          add(u, n, 'draft.switch', '同一操作替换选择与草稿，未见显式冲刷旧草稿；核对未保存及保存失败路径')
        }
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'getPropertyValue') {
        const a = n.arguments[0]
        if (a && ts.isStringLiteral(a) && /[A-Z]/.test(a.text)) add(u, n, 'cssom.name', 'getPropertyValue需要CSS短横线属性名，camelCase会读到空值', 'high')
      }
    })
    if (chart || mono) inventory.push({ file: u.file, mono, explicitDrawing: chart, registered: contracts.charts.includes(u.file) })
  }
  for (const u of units) visit(u.ast, n => {
    if (ts.isFunctionDeclaration(n) && n.name && /^build.*(?:ImportGuide|Guide)$/.test(n.name.text) && !(calls.get(n.name.text) > 0) && !callbackUses.has(n.name.text)) {
      add(u, n, 'wiring.guide', '说明生成器未见生产调用（测试/再导出不算接线）；核对下载入口与回调传递')
    }
  })
  for (const item of inventory.filter(x => x.mono && !x.registered)) findings.push({ rule: 'coverage.chart', confidence: 'review', file: item.file, line: 1, message: 'mono感知组件未列入图表清单；确认是已覆盖的子组件或补运行场景' })
  // Audit the auditors too: the historical camelCase CSSOM bug lived in a browser tool, not src/.
  const toolsDir = path.join(root, '.workbuddy/tools')
  if (fs.existsSync(toolsDir)) for (const name of fs.readdirSync(toolsDir)) {
    if (!/\.(cjs|mjs|js)$/.test(name)) continue
    const filename = path.join(toolsDir, name)
    const u = { file: `.workbuddy/tools/${name}`, ast: ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true) }
    visit(u.ast, n => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'getPropertyValue') {
        const arg = n.arguments[0]
        if (arg && ts.isStringLiteral(arg) && /[A-Z]/.test(arg.text)) add(u, n, 'cssom.name', '审计脚本使用camelCase读取CSS属性，可能把空值误当作默认值', 'high')
      }
    })
  }
  return { files: units.length, findings: [...new Map(findings.map(f => [`${f.file}:${f.line}:${f.rule}`, f])).values()], inventory }
}
