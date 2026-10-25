// 极简内存版云数据库：只实现项目里用到的查询语义（等值 / exists / in / neq / 比较 / and / or / regexp），
// 并把每次 where / orderBy / skip / limit 记到 db.log，供测试断言查询条件。不是通用实现。
const cmdTarget = {};
const mkOps = () => new Proxy(cmdTarget, { get: (t, op) => (...a) => ({ __op: String(op), v: a[0], a }) });
// 字段级操作符支持链式 .and() / .or()（如 _.exists(true).and(_.nin([...]))）
const mkOp = (op, a) => ({
  __op: String(op), v: a[0], a,
  and(x) { return { __op: 'fand', v: [this, x] }; },
  or(x) { return { __op: 'for', v: [this, x] }; }
});
const command = new Proxy({}, {
  get: (t, op) => (op === 'aggregate' ? mkOps() : (...a) => mkOp(op, a))
});

const num = x => (x instanceof Date ? x.getTime() : x);

function matchVal(v, c) {
  if (c && typeof c === 'object' && c.__op) {
    switch (c.__op) {
      case 'fand': return c.v.every(x => matchVal(v, x));
      case 'for': return c.v.some(x => matchVal(v, x));
      case 'exists': return c.v ? v !== undefined : v === undefined;
      case 'in': return c.v.includes(v);
      case 'nin': return !c.v.includes(v);
      case 'neq': return v !== c.v;
      case 'gt': return v !== undefined && num(v) > num(c.v);
      case 'gte': return v !== undefined && num(v) >= num(c.v);
      case 'lt': return v !== undefined && num(v) < num(c.v);
      case 'lte': return v !== undefined && num(v) <= num(c.v);
      case 'regexp': return new RegExp(c.v.regexp, c.v.options).test(String(v === undefined ? '' : v));
      default: throw new Error('fakedb: 不支持的字段操作符 ' + c.__op);
    }
  }
  return v === c;
}

function matchDoc(d, cond) {
  if (cond && cond.__op === 'and') return cond.v.every(x => matchDoc(d, x));
  if (cond && cond.__op === 'or') return cond.v.some(x => matchDoc(d, x));
  return Object.keys(cond || {}).every(k => matchVal(d[k], cond[k]));
}

class Query {
  constructor(db, name, cond) { this.db = db; this.name = name; this.cond = cond || {}; this.orders = []; this._skip = 0; this._limit = 20; }
  orderBy(k, dir) { this.orders.push([k, dir]); return this; }
  skip(n) { this._skip = n; return this; }
  limit(n) { this._limit = n; return this; }
  field() { return this; }
  _rows() { return (this.db.data[this.name] || []).filter(d => matchDoc(d, this.cond)); }
  async get() {
    this.db.log.push({ op: 'get', col: this.name, cond: this.cond, orders: this.orders.slice(), skip: this._skip, limit: this._limit });
    return { data: this._rows().slice(this._skip, this._skip + this._limit) };
  }
  async count() {
    this.db.log.push({ op: 'count', col: this.name, cond: this.cond });
    return { total: this._rows().length };
  }
  // db.applyUpdates = true 时按条件把 data 里的字段写进匹配的行（用于验证条件更新 / 先到先得）；默认只记录、返回 0
  async update(o) {
    this.db.log.push({ op: 'update', col: this.name, cond: this.cond, data: o && o.data });
    if (!this.db.applyUpdates) return { stats: { updated: 0 } };
    const rows = this._rows();
    rows.forEach(d => Object.assign(d, o.data));
    return { stats: { updated: rows.length } };
  }
  async remove() { this.db.log.push({ op: 'remove', col: this.name, cond: this.cond }); return { stats: { removed: 0 } }; }
}

class Agg {
  constructor(db, name) { this.db = db; this.name = name; this.stages = []; }
  match(c) { this.stages.push(['match', c]); return this; }
  group(g) { this.stages.push(['group', g]); return this; }
  sort(s) { this.stages.push(['sort', s]); return this; }
  limit(n) { this.stages.push(['limit', n]); return this; }
  project(p) { this.stages.push(['project', p]); return this; }
  async end() { this.db.log.push({ op: 'aggregate', col: this.name, stages: this.stages }); return { list: this.db.aggList ? this.db.aggList(this) : [] }; }
}

class FakeDb {
  constructor() { this.command = command; this.RegExp = o => ({ __op: 'regexp', v: o }); this.serverDate = () => new Date(); this.reset(); }
  reset() { this.data = {}; this.log = []; this.applyUpdates = false; return this; }
  seed(col, docs) { this.data[col] = (this.data[col] || []).concat(docs); return this; }
  async createCollection() { return {}; }
  collection(name) {
    const db = this;
    return {
      where: cond => new Query(db, name, cond),
      aggregate: () => new Agg(db, name),
      field: () => new Query(db, name, {}),
      limit: n => new Query(db, name, {}).limit(n),
      orderBy: (k, d) => new Query(db, name, {}).orderBy(k, d),
      count: () => new Query(db, name, {}).count(),
      add: async () => ({ _id: 'new' }),
      doc: id => ({
        async get() {
          const d = (db.data[name] || []).find(x => x._id === id);
          if (!d) throw new Error('document.get:fail document not exist');
          return { data: d };
        },
        async update() { return { stats: { updated: 1 } }; },
        async set() { return {}; },
        async remove() { return { stats: { removed: 1 } }; }
      })
    };
  }
}

module.exports = { FakeDb, matchDoc };
