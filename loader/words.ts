/**
 * Activity words for the randomized working loader: pi-frame's own Chinese set.
 *
 * A random entry is picked when a turn starts and whenever a tool starts running
 * (see SessionManager in ./session.ts). `past_tense` is kept for word-pack
 * compatibility; pi-frame has no completion marker that would display it.
 */

export interface WordEntry {
	present_tense: string;
	past_tense: string;
}

const done = (present_tense: string): WordEntry => ({ present_tense, past_tense: "搞定" });

export const WORDS: WordEntry[] = [
	// 厨房
	"颠勺中", "小火慢炖", "揉面醒面", "给代码勾个芡", "焯水去腥", "撒一把葱花", "收汁", "看火候",
	"切配备料", "试咸淡", "蒸一笼包子", "爆香蒜末",
	// 修仙
	"运功调息", "闭关参悟", "冲击瓶颈", "渡劫中", "炼丹", "御剑赶来", "打坐", "推演天机",
	"凝结金丹", "翻阅秘籍",
	// 工位
	"疯狂敲键盘", "续杯咖啡", "对着小黄鸭解释", "翻 Stack Overflow", "假装很懂", "掐指一算",
	"开会对齐", "拉通一下", "抓耳挠腮", "盯着屏幕发呆", "重启试试", "默念不要报错",
	"祈祷编译通过", "把 bug 当 feature", "给变量取名字", "删了又写", "偷偷 git blame",
	// 手艺人
	"绣花", "描红", "拧螺丝", "捏泥人", "打磨棱角", "穿针引线", "雕琢细节", "搭积木",
	"刨木头", "裱糊",
	// 江湖
	"磨刀霍霍", "摩拳擦掌", "排兵布阵", "锦囊妙计中", "飞鸽传书", "摸着石头过河", "三思而后行",
	"见招拆招", "按图索骥", "顺藤摸瓜",
	// 日常
	"挠头", "伸懒腰", "转笔", "泡茶", "嗑瓜子", "遛弯思考", "翻箱倒柜", "拆快递", "整理抽屉",
	"听雨", "数羊", "晒太阳",
	// 科学
	"做实验", "观察样本", "调参", "炼丹（深度学习版）", "对齐量纲", "推公式", "画受力分析图",
	"反复验算", "查文献",
	// 猫
	"踩奶", "追激光笔", "把东西推下桌", "揣手手", "巡视领地", "打呼噜",
].map(done);
