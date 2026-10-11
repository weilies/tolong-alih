import { chromium } from "@playwright/test";
// Marketing images (1080x1080). Edit wording in COPY only, then from the repo root: node scripts/marketing-ads.mjs
const COPY = {
  zh: { file:"tolong-alih-softlaunch-zh-c1", badge:"试用中 SOFT LAUNCH", hl:"不挡人财路，", head2:"Block 车也不怕被骂", hs:128, h2s:104,
        sub:"对方马上收到通知，<br>你的电话号码不用给陌生人", foot:"Next Novas" },
  ms: { file:"tolong-alih-softlaunch-ms-m1", badge:"SOFT LAUNCH", hl:"Kena block?", head2:"Tak payah bengang.", hs:124, h2s:104,
        sub:"Taip plat, pemandu tu terus dapat notis.<br>Nombor anda tak payah bagi<br>kat orang tak kenal.", foot:"Next Novas" },
};
const stripes = "repeating-linear-gradient(45deg,#FFD200 0 34px,#16150F 34px 68px)";
const font = "'WenQuanYi Zen Hei','Noto Sans CJK SC',Arial,sans-serif";
const html = (c) => `<body style="margin:0"><div style="width:1080px;height:1080px;background:#16150F;position:relative;font-family:${font};color:#fff;overflow:hidden">
<div style="position:absolute;left:0;right:0;top:0;height:46px;background:${stripes}"></div>
<div style="position:absolute;left:0;right:0;bottom:0;height:46px;background:${stripes}"></div>
<div style="position:absolute;left:70px;right:70px;top:120px">
  <div style="display:inline-block;background:#FFD200;color:#16150F;padding:10px 26px;font-weight:900;font-size:34px;letter-spacing:3px;border:4px solid #fff">${c.badge}</div>
  <div style="font-weight:900;font-size:${c.hs}px;line-height:1.18;margin-top:44px"><span style="background:#FFD200;color:#16150F;padding:0 18px;white-space:nowrap">${c.hl}</span><br><span style="white-space:nowrap;font-size:${c.h2s}px">${c.head2}</span></div>
  <div style="font-size:48px;font-weight:700;margin-top:50px;color:#FFD200;line-height:1.35">${c.sub}</div>
</div>
<div style="position:absolute;left:70px;right:70px;bottom:88px;font-size:40px;font-weight:700;display:flex;justify-content:space-between;align-items:center"><span>🚗 alih.nextnovas.com</span><span style="font-size:30px;opacity:.75">${c.foot}</span></div>
</div></body>`;
const b = await chromium.launch();
for (const c of Object.values(COPY)) {
  const pg = await b.newPage({ viewport:{width:1080,height:1080} });
  await pg.setContent(html(c));
  await pg.screenshot({ path:`public/marketing/${c.file}.png` });
}
await b.close();
