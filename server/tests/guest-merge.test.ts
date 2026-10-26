import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGuestMerge } from '../src/guest-merge.js';
const project = (id:string, name:string, parentId:string|null = null) => ({ id, name, parentId, archived:false });
const row = (data:any, deleted = false, generation = '1') => ({ id:data.id, data, generation, deleted_at:deleted ? 'deleted' : null });
const session = (id:string, projectId = 'p') => ({ id, projectId, startedAtSec:100, endedAtSec:160, durationSeconds:60, pauses:[] });

test('same IDs retain current account project metadata and skip existing or deleted records', () => {
  const plan = planGuestMerge({ projects:[project('p','旧名称')], sessions:[session('s'),session('deleted')] },
    [row(project('p','账号新名称'))], [row(session('s')),row(session('deleted'),true)], '1');
  assert.equal(plan.mapping.p, 'p');
  assert.deepEqual(plan.sessionMapping, { s:'skip', deleted:'skip' });
  assert.deepEqual(plan.projectOverrides, {});
});
test('deleted or retired project subtrees and their records cannot return through a guest copy', () => {
  const plan = planGuestMerge({ projects:[project('child','子项目','p'),project('p','根')], sessions:[session('s','child')] },
    [row(project('p','根'),true)], [], '1');
  assert.deepEqual([...plan.skippedProjects].sort(), ['child','p']);
  assert.equal(plan.sessionMapping.s, 'skip');
  assert.equal(planGuestMerge({ projects:[project('old','旧代际')], sessions:[] }, [row(project('old','旧代际'),false,'1')], [], '2').skippedProjects.has('old'), true);
});
test('matching project hierarchy is reused and exact records with different IDs are not counted twice', () => {
  const plan = planGuestMerge({ projects:[project('guest-root','数学'),project('guest-child','高数','guest-root')],
    sessions:[session('copy','guest-child'),{ ...session('new','guest-child'), startedAtSec:200, endedAtSec:260 }] },
    [row(project('account-root','数学')),row(project('account-child','高数','account-root'))],
    [row(session('old','account-child'))], '1');
  assert.deepEqual(plan.mapping, { 'guest-root':'account-root', 'guest-child':'account-child' });
  assert.deepEqual(plan.sessionMapping, { copy:'skip' });
});
test('same names in a different parent are renamed rather than merged into the wrong project', () => {
  const plan = planGuestMerge({ projects:[project('p','新分类'),project('child','英语','p')], sessions:[] },
    [row(project('account','英语'))], [], '1');
  assert.equal(plan.mapping.child, undefined);
  assert.equal(plan.projectOverrides.child.name, '英语（登录前）');
  assert.equal(plan.projectOverrides.child.parentId, 'p');
});
test('an archived account parent remains archived and new children remain valid', () => {
  const plan = planGuestMerge({ projects:[project('p','数学'),project('child','高数','p')], sessions:[] },
    [row({ ...project('p','数学'), archived:true })], [], '1');
  assert.equal(plan.projectOverrides.child.archived, true);
});
test('duplicate source facts are skipped while invalid parent graphs fail without a partial plan', () => {
  const plan = planGuestMerge({ projects:[project('p','数学')], sessions:[session('a'),session('b')] }, [], [], '1');
  assert.deepEqual(plan.sessionMapping, { b:'skip' });
  assert.throws(() => planGuestMerge({ projects:[project('p','环','p')], sessions:[] }, [], [], '1'));
});

test('independent overlapping device records are retained while an exact copy is skipped', () => {
  const existing=session('account');
  const overlapping={...session('other-device'),startedAtSec:120,endedAtSec:140,durationSeconds:20};
  const plan=planGuestMerge({projects:[project('p','数学')],sessions:[{...existing,id:'copy'},overlapping]},
    [row(project('p','数学'))],[row(existing)],'1');
  assert.equal(plan.sessionMapping.copy,'skip');
  assert.equal(plan.sessionMapping['other-device'],undefined);
});
