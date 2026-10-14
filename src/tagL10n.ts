// tags / brand 的展示层译文（文档I §3.4）。
// 为什么在前端：tags 是 jsonb 字符串数组、brand 是自由文本列，平台 DDL 子集不允许给数组元素建语言列；
// 为这两个字段另开字典表等于给纯展示属性引入 JOIN，违背总则「逻辑引用优先」。
// 铁律：**只翻译显示，绝不改动筛选参数** —— 分类页品牌 chip 的 URL/查询值永远是库内原文。
// 未知词条原样返回（拼写差异由 catalog/brands 聚合自然暴露，不做静默兜底）。
// key 必须与 _scratch/catalog-seed.mjs / 后台录入的字面值逐字一致。

const LANG_INDEX: Record<string, number> = { en: 0, ja: 1, ko: 2, es: 3 };

function term(map: Record<string, readonly [string, string, string, string]>, raw: string, lang: string): string {
  const row = map[raw];
  if (!row) return raw;
  const i = LANG_INDEX[lang];
  return i === undefined ? raw : row[i];
}

export const tagText = (tag: string, lang: string) => term(TAG_TEXT, tag, lang);
export const brandText = (brand: string, lang: string) => term(BRAND_TEXT, brand, lang);

// [en, ja, ko, es] —— 中文即用 key 原样显示
const TAG_TEXT: Record<string, readonly [string, string, string, string]> = { /* i18n-fallback */
  降噪: ["Noise Cancelling", "ノイズキャンセリング", "노이즈 캔슬링", "Cancelación de ruido"],
  蓝牙耳机: ["Bluetooth Earphones", "Bluetoothイヤホン", "블루투스 이어폰", "Auriculares Bluetooth"],
  耳机: ["Headphones", "ヘッドホン", "헤드폰", "Auriculares"],
  监听: ["Monitoring", "モニター", "모니터링", "Monitorización"],
  智能穿戴: ["Smart Wearable", "スマートウェアラブル", "스마트 웨어러블", "Reloj inteligente"],
  运动: ["Sport", "スポーツ", "스포츠", "Deporte"],
  充电器: ["Charger", "充電器", "충전기", "Cargador"],
  出行: ["Travel", "トラベル", "여행", "Viaje"],
  护肤: ["Skincare", "スキンケア", "스킨케어", "Cuidado de la piel"],
  清洁: ["Cleansing", "洗顔", "클렌징", "Limpieza"],
  敏感肌: ["Sensitive Skin", "敏感肌", "민감성", "Piel sensible"],
  保湿: ["Moisturizing", "保湿", "보습", "Hidratación"],
  补水: ["Hydrating", "水分チャージ", "수분 충전", "Aporte de agua"],
  彩妆: ["Makeup", "メイク", "메이크업", "Maquillaje"],
  唇部: ["Lips", "リップ", "립", "Labios"],
  基础款: ["Essential", "ベーシック", "베이직", "Básico"],
  纯棉: ["100% Cotton", "綿100%", "순면", "100 % algodón"],
  牛仔: ["Denim", "デニム", "데님", "Denim"],
  通勤: ["Commute", "通勤", "출퇴근", "Entretiempo"],
  羽绒: ["Down", "ダウン", "다운", "Plumas"],
  秋冬: ["Fall & Winter", "秋冬", "가을·겨울", "Otoño e invierno"],
  云南: ["Yunnan", "雲南", "윈난", "Yunnan"],
  现摘: ["Fresh Picked", "朝採れ", "갓 수확", "Recién recogido"],
  冷链: ["Cold Chain", "コールドチェーン", "콜드체인", "Cadena de frío"],
  当日达: ["Same-Day", "当日配送", "당일 배송", "Entrega el mismo día"],
  香氛: ["Fragrance", "フレグランス", "향기", "Fragancia"],
  无火: ["Flameless", "火を使わない", "무화재", "Sin llama"],
  礼物: ["Gift", "ギフト", "선물", "Regalo"],
  办公: ["Office", "オフィス", "사무실", "Oficina"],
  居家: ["Home", "ホーム", "홈", "Hogar"],
  人体工学: ["Ergonomic", "人間工学", "인체공학", "Ergonomía"],
  烘焙: ["Bakery", "ベーカリー", "베이커리", "Panadería"],
  无添加: ["No Additives", "無添加", "무첨가", "Sin aditivos"],
  餐具: ["Tableware", "食器", "식기", "Vajilla"],
  手工: ["Handmade", "手づくり", "수제", "Hecho a mano"],
  瑜伽: ["Yoga", "ヨガ", "요가", "Yoga"],
  居家健身: ["Home Workout", "宅トレ", "홈트", "Entrenamiento en casa"],
  跑步: ["Running", "ランニング", "러닝", "Running"],
  户外: ["Outdoor", "アウトドア", "아웃도어", "Aire libre"],
  力量: ["Strength", "筋トレ", "근력", "Fuerza"],
};

// 拉丁品牌名（AURA/ERGO/MUTE/NOVA/NORD/RIDGE/SOLEN/TERRA/VEORA）五语通用，不入表
const BRAND_TEXT: Record<string, readonly [string, string, string, string]> = { /* i18n-fallback */
  云岭鲜果: ["Yunling Fresh", "雲嶺フレッシュ", "윈링 프레시", "Yunling Fresco"],
  麦穗工坊: ["Wheat Ear Studio", "麦穂工房", "밀이삭 공방", "Taller Espiga"],
};
