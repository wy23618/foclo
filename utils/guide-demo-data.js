const PROJECTS = [
  { id: 'study', name: '学习', parentId: '', level: 0, children: true },
  { id: 'math', name: '数学', parentId: 'study', level: 1, children: true },
  { id: 'calculus', name: '高等数学', parentId: 'math', level: 2 },
  { id: 'geometry', name: '几何', parentId: 'math', level: 2 },
  { id: 'english', name: '英语', parentId: 'study', level: 1, children: true },
  { id: 'vocabulary', name: '词汇', parentId: 'english', level: 2 },
  { id: 'reading', name: '阅读', parentId: 'study', level: 1 },
  { id: 'life', name: '生活', parentId: '', level: 0, children: true },
  { id: 'swimming', name: '游泳', parentId: 'life', level: 1 },
  { id: 'meditation', name: '冥想', parentId: 'life', level: 1 }
];

module.exports = { PROJECTS };
