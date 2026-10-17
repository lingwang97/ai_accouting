// components/batch-list — 批次录入：一次登记多位随礼人（姓名 / 金额 / 关系 / 礼品备注），自动合计
// 随礼页（宾客）与礼台现金登记页共用；每次修改触发 change 事件：{ rows, count, total }
const scenes = require('../../utils/scenes.js');

const { MAX } = require('../../utils/batch.js');
const emptyRow = () => ({ name: '', amount: '', relation: '', remark: '' });

Component({
  properties: {
    firstLabel: { type: String, value: '' }, // 第一位的标注，如"本人"
    quick: { type: Array, value: [] }        // 快捷金额
  },

  data: {
    rows: [emptyRow(), emptyRow()],
    relations: scenes.RELATIONS,
    max: MAX,
    count: 0,
    totalStr: '0.00'
  },

  lifetimes: {
    attached() { this.emit(); }
  },

  methods: {
    onInput(e) {
      const { i, k } = e.currentTarget.dataset;
      this.setRow(i, k, e.detail.value);
    },
    onQuick(e) {
      const { i, v } = e.currentTarget.dataset;
      this.setRow(i, 'amount', String(v));
    },
    onRelation(e) {
      this.setRow(e.currentTarget.dataset.i, 'relation', this.data.relations[Number(e.detail.value)]);
    },
    /** 只改已有的行，防止越界写入凭空多出随礼人 */
    setRow(i, k, v) {
      i = Number(i);
      if (!(i >= 0 && i < this.data.rows.length)) return;
      this.setData({ [`rows[${i}].${k}`]: v });
      this.emit();
    },
    onAdd() {
      if (this.data.rows.length >= MAX) return;
      this.setData({ rows: this.data.rows.concat(emptyRow()) });
      this.emit();
    },
    onDel(e) {
      const i = Number(e.currentTarget.dataset.i);
      const rows = this.data.rows.filter((x, k) => k !== i);
      this.setData({ rows: rows.length ? rows : [emptyRow()] });
      this.emit();
    },

    /** 清空名单（登记完一批后） */
    reset() {
      this.setData({ rows: [emptyRow(), emptyRow()] });
      this.emit();
    },

    /** 合计：只算填了金额的行 */
    emit() {
      const rows = this.data.rows;
      const filled = rows.filter(r => (r.name || '').trim() || Number(r.amount) > 0);
      const fen = filled.reduce((t, r) => t + (Number(r.amount) > 0 ? Math.round(Number(r.amount) * 100) : 0), 0);
      const totalStr = (fen / 100).toFixed(2);
      this.setData({ count: filled.length, totalStr });
      this.triggerEvent('change', { rows, count: filled.length, total: fen / 100 });
    }
  }
});

