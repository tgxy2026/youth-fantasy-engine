// Built-in, pre-reviewed example. The fixed ID makes initialization idempotent;
// moderation can still take it down, and a restart will not restore it.
export const COMMUNITY_EXAMPLE_ID = 'example_story_v1'

export function ensureCommunityExample(store) {
  if (store.getPost(COMMUNITY_EXAMPLE_ID)) return
  const now = Date.now()
  const vid = 'example_story_version_1'
  store.putPost({
    id: COMMUNITY_EXAMPLE_ID,
    uid: '__community_example__',
    isExample: true,
    status: 'published',
    display: 'anonymous',
    createdAt: now,
    updatedAt: now,
    versions: [{
      vid,
      title: '给明天留一盏灯',
      body: '雨停的时候，街角的旧书店还亮着灯。\n\n小满推门进去，发现窗边多了一只纸盒。盒子上写着：如果今天过得不太顺利，就从这里挑一句话带走。\n\n她随手抽出一张纸条，上面只有短短一行字：“慢一点也没关系，星星也是天黑以后才出现的。”\n\n第二天，她带来一张新的纸条，悄悄放进盒子。',
      tags: ['短篇'],
      createdAt: now,
    }],
    pendingVersionId: '',
    publishedVersionId: vid,
    counts: { up: 0, down: 0, comments: 0 },
  })
}
