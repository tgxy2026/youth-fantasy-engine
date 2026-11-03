// 3.3.2 · 云端接口契约 · 单测
//
// 【为什么要专门测这个】2026-10-31 实机验证发现：`GET .../manifest` 返回的是
// `{ ok, revision, manifest, current }`，清单在**里层**，而客户端 `fetchManifest`
// 直接把整个外包对象当清单返回 ⇒ 下游 `planApply` 读到 `objects === undefined`
// ⇒ 一律判「云端清单格式无法识别」⇒ **拉取功能全线不可用**，而单测与服务端自检全绿。
//
// 这类 bug 的共性：**两端各自都对，中间的"接线"错了**。只能靠"用真实响应形状断言"来钉住。
// 所以这里的 fetch 桩返回的是**服务端真实返回的那一层**，不是理想化的清单。
import { fetchManifest, probeCloudProject, createCloudProject } from '@/lib/cloud/syncApi'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const MANIFEST = {
  protocol: 1, createdAt: 1, project: { name: '书', genre: '玄幻' }, counts: {},
  objects: [{ kind: 'chapters', hash: 'a'.repeat(64), bytes: 10, records: 1 }],
  assets: [], tombstones: [],
}

/** 用真实响应形状做桩：服务端就是这么包的 */
function stubFetch(body: unknown, status = 200) {
  const calls: string[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url))
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = orig } }
}

async function main() {
  // ---------- 1. 清单必须解包（这条钉住那个阻断问题）----------
  {
    const s = stubFetch({ ok: true, revision: 7, manifest: MANIFEST, current: 7 })
    const m = await fetchManifest('prj_x')
    s.restore()
    ok('fetchManifest 返回里层清单（objects 在顶层）', Array.isArray(m?.objects) && (m!.objects as unknown[]).length === 1,
      JSON.stringify(Object.keys(m || {})))
    ok('把外层 revision 合进清单（planApply 要用）', m?.revision === 7, String(m?.revision))
    ok('不把外层 ok 字段混进清单（否则下游会当脏数据）', !('ok' in (m || {})), JSON.stringify(Object.keys(m || {})))
  }

  // ---------- 2. 响应缺清单时要返回 null，而不是空壳 ----------
  {
    const s = stubFetch({ ok: true, revision: 3 })
    const m = await fetchManifest('prj_x')
    s.restore()
    // 🔴 返回 `{}` 会让 `planApply` 判 PROTOCOL 之外还可能被判"云端这一版没有内容"，
    //    用户会以为"云端空了"，其实是接口变了。null 才能让上层说"取不到清单"。
    ok('响应里没有 manifest ⇒ null（不能返回空对象）', m === null, JSON.stringify(m))
  }
  {
    const s = stubFetch({ ok: true, revision: 3, manifest: [] })
    const m = await fetchManifest('prj_x')
    s.restore()
    ok('manifest 是数组也当非法（形状不对）', m === null, JSON.stringify(m))
  }

  // ---------- 3. HTTP 失败 ----------
  {
    const s = stubFetch({ ok: false }, 404)
    const m = await fetchManifest('prj_x')
    s.restore()
    ok('404 返回 null', m === null)
  }

  // ---------- 4. 探针结果直接是 state（不能被外层包住）----------
  {
    const s = stubFetch({ ok: true, revision: 5, snapshotId: 's5', name: '书' })
    const p = await probeCloudProject('prj_y')
    s.restore()
    ok('probe 解出 revision', p.ok && p.state.revision === 5, JSON.stringify(p))
  }

  // ---------- 5. 新建返回 cloudProjectId ----------
  {
    const s = stubFetch({ ok: true, cloudProjectId: 'prj_new', revision: 0 })
    const r = await createCloudProject({ name: 'x' })
    s.restore()
    ok('新建解出 cloudProjectId', r.ok && r.cloudProjectId === 'prj_new', JSON.stringify(r))
  }

  console.log(`\n▶ cloudManifestContract: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
