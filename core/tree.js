// core/tree.js
// 项目树纯函数：父链、子树、根聚合、本级/子项分解、可开始判定。
// projects: { [id]: { id, name, parentId, archived, ... } }

function buildIndex(projects) {
  const ids = Object.keys(projects);
  const childrenMap = {};
  for (let i = 0; i < ids.length; i++) {
    const p = projects[ids[i]];
    const key = p.parentId || '__ROOT__';
    if (!childrenMap[key]) childrenMap[key] = [];
    childrenMap[key].push(p.id);
  }
  const sortKeys = Object.keys(childrenMap);
  for (let i = 0; i < sortKeys.length; i++) {
    const list = childrenMap[sortKeys[i]];
    list.sort((a, b) => {
      const pa = projects[a];
      const pb = projects[b];
      if (pa.creationOrder !== pb.creationOrder) return pa.creationOrder - pb.creationOrder;
      return pa.createdAtSec - pb.createdAtSec;
    });
  }
  return { byId: projects, childrenMap };
}

function directChildren(index, parentId) {
  return index.childrenMap[parentId || '__ROOT__'] || [];
}

// 未归档的直接子项
function activeDirectChildren(index, parentId) {
  const list = directChildren(index, parentId);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (!index.byId[list[i]].archived) out.push(list[i]);
  }
  return out;
}

// 可开始（D03）：没有未归档的直接子项
function isStartable(index, projectId) {
  return activeDirectChildren(index, projectId).length === 0;
}

// 祖先链（不含自身），自根向父：[rootId, ..., parentId]
function ancestors(index, projectId) {
  const out = [];
  let cur = projectId;
  const guard = new Set();
  while (cur) {
    if (guard.has(cur)) break; // 环保护
    guard.add(cur);
    const p = index.byId[cur];
    if (!p || !p.parentId) break;
    out.push(p.parentId);
    cur = p.parentId;
  }
  return out.reverse();
}

function rootIdOf(index, projectId) {
  const chain = ancestors(index, projectId);
  return chain.length ? chain[0] : projectId;
}

// 子树成员（含自身）
function subtreeIds(index, projectId) {
  const out = [];
  const stack = [projectId];
  while (stack.length) {
    const id = stack.pop();
    out.push(id);
    const kids = directChildren(index, id);
    for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
  }
  return out;
}

// 路径名称：[rootName, ..., name]
function pathNames(index, projectId) {
  const chain = ancestors(index, projectId).concat([projectId]);
  return chain.map((id) => index.byId[id].name);
}

// 把任意项目 id 映射到其根 id（总览只归入一个根，父子不重复相加）
function rollUpMap(index) {
  const map = {};
  const ids = Object.keys(index.byId);
  for (let i = 0; i < ids.length; i++) {
    map[ids[i]] = rootIdOf(index, ids[i]);
  }
  return map;
}

// 项目下钻分解：直接子项各自汇总子树，父项本级单列。
// secondsById: { [projectId]: seconds }
function childBreakdown(index, projectId, secondsById) {
  const kids = directChildren(index, projectId);
  const children = kids.map((kidId) => {
    const members = subtreeIds(index, kidId);
    let seconds = 0;
    for (let i = 0; i < members.length; i++) {
      seconds += secondsById[members[i]] || 0;
    }
    return { projectId: kidId, name: index.byId[kidId].name, archived: index.byId[kidId].archived, seconds };
  });
  return {
    selfSeconds: secondsById[projectId] || 0,
    children
  };
}

module.exports = {
  buildIndex,
  directChildren,
  activeDirectChildren,
  isStartable,
  ancestors,
  rootIdOf,
  subtreeIds,
  pathNames,
  rollUpMap,
  childBreakdown
};
