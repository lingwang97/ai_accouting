// 用假的 wx-server-sdk 加载云函数入口：本地没装 wx-server-sdk，也不连真实云环境。
const Module = require('module');
const path = require('path');
const { FakeDb } = require('./fakedb.js');

const ROOT = path.join(__dirname, '..', '..');
const db = new FakeDb();
const state = { openid: 'tester', files: {}, calls: [], uploads: [], download: async () => { throw new Error('sdk-stub: state.download 未设置'); } };

const sdk = {
  DYNAMIC_CURRENT_ENV: 'test-env',
  init() {},
  database: () => db,
  getWXContext: () => ({ OPENID: state.openid, APPID: 'wx-test', ENV: 'test-env' }),
  callFunction: async o => { state.calls.push(o); return { result: { code: 0, data: null } }; },
  uploadFile: async o => { state.uploads.push({ cloudPath: o.cloudPath, content: o.fileContent }); return { fileID: 'cloud://test/' + o.cloudPath }; },
  downloadFile: async o => ({ fileContent: await state.download(o.fileID) }),
  deleteFile: async () => ({ fileList: [] }),
  getTempFileURL: async () => ({ fileList: [] }),
  openapi: {}
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return sdk;
  return origLoad.apply(this, arguments);
};

/** 重新加载某个云函数入口（清掉该云函数目录下的模块缓存），返回其 exports */
function loadFunction(name) {
  const dir = path.join(ROOT, 'cloudfunctions', name) + path.sep;
  Object.keys(require.cache).forEach(k => { if (k.startsWith(dir)) delete require.cache[k]; });
  return require(path.join(dir, 'index.js'));
}

module.exports = { sdk, db, state, loadFunction, ROOT };
