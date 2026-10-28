import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DomainStore } from '../../src/application/store'
import { emptyRegistry } from '@moqi/editor'
import { usePropertyEditor } from '../../src/ui/usePropertyEditor'
import type { UiPrefs } from '../../src/ui/uiPrefs'
import type { Block } from '@moqi/editor'

/**
 * `usePropertyEditor`（外壳拆分第四刀）的行为测试：三个写入口 —— 挂载 / 取值 / 改名。
 * 手法：用一个探针组件在**静态渲染**里调 hook（回调被渲染期捕获），渲染后直接调它们——
 * 不需要事件循环，断言的是"这圈闭包对 store / registry / 偏好做了什么"。
 */

const page = (id: string, properties: unknown[] = []): Block => ({
  entityId: id, blockUid: id.padEnd(8, '0').slice(0, 8), type: 'text',
  content: [{ t: 'text', v: '正文' }], parent: null, children: [], position: 0,
  collapsed: false, checked: false, deleted: false, deletedAt: null, prevParent: null, prevIndex: null,
  isObject: true, objectName: '测试页', properties, tags: [], blockRefs: [], blockBackRefs: [],
  objectRefs: [], objectBackRefs: [], aiMeta: null, created: 1, modified: 1,
}) as unknown as Block

function harness() {
  const store = new DomainStore([page('p1')])
  let registry = emptyRegistry()
  const toasts: string[] = []
  let closed = 0
  let prefs: UiPrefs = { recentProperties: [] } as unknown as UiPrefs
  let api: ReturnType<typeof usePropertyEditor> | null = null

  const Probe = () => {
    api = usePropertyEditor({
      registry,
      updateRegistry: (next) => { registry = next },
      store,
      activePageId: 'p1',
      prefs,
      updatePrefs: (next) => { prefs = next },
      persist: () => undefined,
      notify: (message) => { toasts.push(message) },
      closeDialog: () => { closed += 1 },
    })
    return null
  }
  // 真实里 setRegistry / setPrefs 会触发重渲染、hook 拿到新值；静态渲染要手动补这一下
  // （改完注册表或偏好后，先 render() 再调下一个入口）。
  const render = () => { renderToStaticMarkup(<Probe />) }
  render()
  return {
    render,
    api: () => {
      if (!api) throw new Error('hook 没被渲染')
      return api
    },
    store, toasts,
    closeCount: () => closed,
    registryNow: () => registry,
    prefsNow: () => prefs,
  }
}

test('PROPS-HOOK-1 挂载属性：往当前页写上初始取值 ＋ 记「最近使用」＋ 关弹窗', () => {
  const h = harness()
  h.api().createProperty('状态', 'select')
  h.render()
  const defId = h.registryNow().properties[0].id
  h.api().mountProperty(defId)
  const mounted = h.store.get('p1')?.properties ?? []
  assert.equal(mounted.length, 1, '页面上多了一条取值')
  assert.equal(mounted[0].defId, defId, '取值挂在同一个 defId 上')
  h.render()
  assert.deepEqual(h.prefsNow().recentProperties, [defId], '「最近使用」记了一笔')
  assert.equal(h.closeCount(), 1, '挂载即关弹窗（点了即加即关）')
})

test('T08/θ4 选项维护四条入口：加 / 改名（撞名拒） / 排序（数组序）/ 删（**先清全库引用该选项的取值**再移除）', () => {
  const h = harness()
  h.api().createProperty('状态', 'select')
  h.render()
  const defId = h.registryNow().properties[0].id
  h.api().mountProperty(defId)                       // 页上先有一条取值（删选项要能清掉它）
  h.api().propertyCallbacks.onSetValue(defId, null)  // 值先置空，稍后按选项挂回来
  h.api().handleAddPropertyOption(defId, '进行中')
  h.render()
  h.api().handleAddPropertyOption(defId, '已完成')
  h.render()
  const opts = () => h.registryNow().properties[0].options ?? []
  assert.deepEqual(opts().map((option) => option.label), ['进行中', '已完成'])

  // 改名：成功；撞别的选项名 / 名字为空 → false（就地一句由界面给，域层不弹通知）
  assert.equal(h.api().handleRenamePropertyOption(defId, opts()[0].id, '进行中（改）'), true)
  h.render()
  assert.deepEqual(opts().map((option) => option.label), ['进行中（改）', '已完成'])
  assert.equal(h.api().handleRenamePropertyOption(defId, opts()[0].id, '已完成'), false)
  assert.equal(h.api().handleRenamePropertyOption(defId, opts()[0].id, '   '), false)

  // 页上挂一条引用「已完成」的取值，再删这个选项：**取值先清**（一块事务、可 ⌘Z）、选项从定义里移除
  h.api().propertyCallbacks.onSetValue(defId, { defId, type: 'select', optionId: opts()[1].id })
  assert.equal((h.store.get('p1')?.properties ?? []).length, 1)
  const undoBefore = h.store.canUndo?.() ?? null
  h.api().handleRemovePropertyOption(defId, opts()[1].id)
  h.render()
  assert.equal((h.store.get('p1')?.properties ?? []).length, 0, '引用该选项的取值被清掉')
  assert.deepEqual(opts().map((option) => option.label), ['进行中（改）'], '选项从定义里移除')
  assert.equal(h.store.get('p1')?.properties?.length, 0)
  void undoBefore

  // 排序：数组序 = 数据（同位置 = 无操作）
  h.api().handleAddPropertyOption(defId, '待办')
  h.render()
  h.api().handleMovePropertyOption(defId, opts()[1].id, 0)
  h.render()
  assert.deepEqual(opts().map((option) => option.label), ['待办', '进行中（改）'])

  // 名称判据的人话（设置页「完成」可点性与就地一句共用）：空 / 撞名 / 合法
  assert.equal(h.api().nameProblemText('  '), '属性名不能为空')
  assert.ok((h.api().nameProblemText('状态') ?? '').includes('已有同名属性'))
  assert.equal(h.api().nameProblemText('状态', defId), null, 'excludeId = 自己 ⇒ 合法（改名不与自己撞）')
  assert.equal(h.api().nameProblemText('阶段'), null)
  assert.ok((h.api().nameProblemText('aliases') ?? '').includes('保留键'), '保留键的说法与建/改共用一份')

  // 空分支：没有一行引用它时，删选项只动注册表（不产生事务）
  h.api().handleAddPropertyOption(defId, '无人在用')
  h.render()
  const emptyOption = (h.registryNow().properties[0].options ?? []).at(-1)
  h.api().handleRemovePropertyOption(defId, emptyOption!.id)
  h.render()
  assert.equal((h.registryNow().properties[0].options ?? []).some((option) => option.id === emptyOption!.id), false)
  h.api().handleRenamePropertyOption(defId, 'missing', '任意')
  assert.equal(h.api().nameProblemText('x', 'missing-def'), null)
})

test('T08/θ4 定义排序：`registry.properties` 数组序 = 数据（摘要条属性行与卡片属性行同序）；不存在 / 同位置 = 无操作', () => {
  const h = harness()
  h.api().createProperty('状态', 'select')
  h.render()
  h.api().createProperty('备注', 'text')
  h.render()
  const names = () => h.registryNow().properties.map((def) => def.name)
  assert.deepEqual(names(), ['状态', '备注'])
  h.api().handleMoveProperty(h.registryNow().properties[1].id, 0)
  h.render()
  assert.deepEqual(names(), ['备注', '状态'])
  const before = JSON.stringify(h.registryNow())
  h.api().handleMoveProperty(h.registryNow().properties[0].id, 0)
  h.render()
  assert.equal(JSON.stringify(h.registryNow()), before, '同位置 = 无操作（不写盘）')
})

test('PROPS-KEEP-1 「从本页删除」＝本页不再显示、**值保留**（§0-10）：行进 propertyHidden、再添加出列且值还在', () => {
  const h = harness()
  h.api().createProperty('优先级', 'select')
  h.render()
  const defId = h.registryNow().properties[0].id
  h.api().mountProperty(defId)
  assert.equal((h.store.get('p1')?.properties ?? []).length, 1)
  h.api().propertyCallbacks.onRemoveProperty(defId)
  assert.equal((h.store.get('p1')?.properties ?? []).length, 1, '**值保留**——要清值就把值清空（既有语义）')
  assert.deepEqual(h.store.get('p1')?.propertyHidden, [defId], '行进了 propertyHidden（本页不再显示）')
  h.api().mountProperty(defId)
  assert.deepEqual(h.store.get('p1')?.propertyHidden, [], '再加回来 → 出列、值不用重填')
  assert.equal(h.registryNow().properties.length, 1, '定义还在注册表里（未动）')
})

test('PROPS-ENTRY-1 默认字段（标签）：添加 → 进 propertyShown 出现；「从本页删除」→ 出列（数据不动，§0-1/§0-2）', () => {
  const h = harness()
  h.api().mountProperty('sys:tags')
  assert.deepEqual(h.store.get('p1')?.propertyShown, ['sys:tags'], '默认字段靠 propertyShown 出现（不再常驻）')
  h.api().propertyCallbacks.onRemoveProperty('sys:tags')
  assert.deepEqual(h.store.get('p1')?.propertyShown, [], '「从本页删除」= 出列；标签数据不动')
})

test('PROPS-HOOK-1 改名走「与建属性同一套判据」：撞名拒（**返回原因**，`§0-6` 不弹通知）＋ 正常改名写回注册表', () => {
  const h = harness()
  h.api().createProperty('状态', 'select')
  h.render()
  h.api().createProperty('优先级', 'select')
  h.render()
  const [first, second] = h.registryNow().properties
  const problem = h.api().handleRenameProperty(second.id, '状态') // 撞名 → 拒
  assert.equal(h.registryNow().properties[1].name, '优先级', '撞名不改')
  assert.ok(problem?.includes('已有同名属性'), '失败原因**就地返回**给调用方（不弹 toast）')
  assert.equal(h.api().handleRenameProperty(second.id, '紧急度'), null, '正常改名返回 null')
  assert.equal(h.registryNow().properties[1].name, '紧急度', '名字写回注册表')
  assert.equal(h.registryNow().properties[0].id, first.id, '另一条不动')
})

test('PROPS-HOOK-1 「建并添加」（弹窗那条路）：定义进注册表 ＋ 本页写入初始取值 ＋ 记「最近使用」；撞名拒', () => {
  const h = harness()
  h.api().createAndAddProperty('状态', 'select')
  assert.equal(h.registryNow().properties.length, 1, '定义建进注册表')
  const defId = h.registryNow().properties[0].id
  const mounted = h.store.get('p1')?.properties ?? []
  assert.equal(mounted.length, 1, '本页多了一条初始取值')
  assert.equal(mounted[0].defId, defId, '取值挂在同一个 defId 上')
  assert.deepEqual(h.prefsNow().recentProperties, [defId], '「最近使用」记了一笔（与列表添加同一条路）')
  assert.equal(h.closeCount(), 0, '关弹窗归弹窗自己（submit 建完即关），这一笔不替它关')
  h.render()
  h.api().createAndAddProperty('状态', 'text') // 撞名 → 与建属性同一套判据
  assert.equal(h.registryNow().properties.length, 1, '撞名：定义不进注册表')
  assert.ok(h.toasts.at(-1)?.includes('已有同名属性'), 'toast 说清原因')
})

test('PROPS-DEL-1 deleteProperty：① 一块事务清全库取值与显示集合（⌘Z 一步带回）② 删定义', () => {
  const h = harness()
  h.api().createProperty('状态', 'select')
  h.render()
  const defId = h.registryNow().properties[0].id
  h.api().mountProperty(defId)
  h.render()
  assert.equal((h.store.get('p1')?.properties ?? []).length, 1, '先挂上（有值 + 显示集合）')
  h.api().deleteProperty(defId)
  assert.equal((h.store.get('p1')?.properties ?? []).length, 0, '取值被清')
  assert.deepEqual(h.store.get('p1')?.propertyShown ?? [], [], '显示集合也清（不留悬空引用）')
  assert.equal(h.registryNow().properties.length, 0, '定义从注册表移除（仅用户建的）')
  assert.equal(h.store.canUndo(), true, '清值是一块事务')
  h.store.undo()
  assert.equal((h.store.get('p1')?.properties ?? []).length, 1, '⌘Z 一步把值带回来（定义不随 oplog 撤）')
})
