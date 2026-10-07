// core/repository.js
// 仓储键布局与本地提交协议（最小事务）。
//
// 键布局：
//   yotick/meta                 空间元信息
//   yotick/projects             项目注册表 { [id]: project }
//   yotick/prefs                展示偏好（可丢失）
//   yotick/s/<sessionId>        会话保存单元（含全部暂停）
//   yotick/d/<YYYY-MM-DD>       日索引：[sessionId]（集合语义，排序去重）
//   yotick/p/<projectId>        项目会话索引：[sessionId]
//   yotick/c/<commitId>         待完成提交描述

const META = 'yotick/meta';
const PROJECTS = 'yotick/projects';
const PREFS = 'yotick/prefs';

const sessionKey = (id) => 'yotick/s/' + id;
const dayIndexKey = (dayKey) => 'yotick/d/' + dayKey;
const projectSessionsKey = (id) => 'yotick/p/' + id;
const commitKey = (id) => 'yotick/c/' + id;

const COMMIT_PREFIX = 'yotick/c/';

// op: { t: 'set', k, v } | { t: 'remove', k }
// 提交协议由 core/service.js 的 persist 执行：先落提交描述（含确定的变更结果），
// 再逐项执行，最后删除描述。中断后由 recoverCommits 按相同内容幂等重放。

// 启动恢复：重放所有未完成提交。
// 返回描述数组（含 operationId），供服务层为“同 operationId 重试”重建结果。
async function recoverCommits(adapter) {
  const allKeys = await adapter.keys();
  const pending = allKeys.filter((k) => k.indexOf(COMMIT_PREFIX) === 0);
  const recovered = [];
  for (let i = 0; i < pending.length; i++) {
    const k = pending[i];
    const desc = await adapter.get(k);
    if (!desc || !Array.isArray(desc.ops)) {
      await adapter.remove(k);
      continue;
    }
    for (let j = 0; j < desc.ops.length; j++) {
      const op = desc.ops[j];
      if (op.t === 'set') {
        await adapter.set(op.k, op.v);
      } else if (op.t === 'remove') {
        await adapter.remove(op.k);
      }
    }
    await adapter.remove(k);
    recovered.push(desc);
  }
  return recovered;
}

module.exports = {
  META,
  PROJECTS,
  PREFS,
  sessionKey,
  dayIndexKey,
  projectSessionsKey,
  commitKey,
  COMMIT_PREFIX,
  recoverCommits
};
