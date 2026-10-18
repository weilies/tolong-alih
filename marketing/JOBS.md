# Job list: Facebook group soft-launch test (Tolong Alih)

Hand this file to a fresh Claude session that has computer use turned on. It is self-contained.
Owner: weilies.chok@gmail.com. Date written: 2026-10-11.

## 0. Before you start (owner)

- [ ] Claude desktop app, Settings -> This computer -> Computer use: ON. Open the new chat from the desktop app (or claude.ai/code with your computer picked under Devices).
- [ ] Chrome is open and already signed in to your Facebook account.
- [ ] Check out branch `claude/fb-link-and-marketing` (it holds the images), or save the two PNGs to your computer (they are in the old chat), or let Claude download them:
  - https://raw.githubusercontent.com/weilies/tolong-alih/claude/fb-link-and-marketing/public/marketing/tolong-alih-softlaunch-zh-c1.png
  - https://raw.githubusercontent.com/weilies/tolong-alih/claude/fb-link-and-marketing/public/marketing/tolong-alih-softlaunch-ms-m1.png
- [ ] First message to the new chat: "Run marketing/JOBS.md". Load computer-use or browser tools first; if none are available, stop and say so.

## 1. Goal

Test the water in **2 public JB (Johor Bahru) Facebook groups only**. Read each group's rules, post only where Tolong Alih does not break them, and report what happened. Nothing else.

## 2. Hard rules (do not break)

1. **Read the rules first, every group.** Open About -> Group rules, plus any pinned post. If a group bans links, promotion, self-ads, "business posts" or requires admin pre-approval you cannot meet, **skip it** and say why.
2. **Public groups only**, and only 2 posts in total. No third post, no reposting, no cross-posting to many groups at once.
3. **Get the owner's OK in chat before pressing Post**, showing the group name, the exact text, the image and the link. No OK, no post.
4. Posts are public and cannot be undone. No deleting or editing other people's content. No commenting on other posts, no joining new groups, no DMs, no likes, no friend or follow actions.
5. Do not click links in posts or messages with computer use; open URLs through the browser tools. Do not enter passwords. If Facebook shows a login check, captcha or "suspicious activity" prompt, **stop** and ask the owner to do it.
6. No hard sell. Human, solopreneur voice. Malaysia only. No paid boosts.
7. No zero-cost claims in any language (f-r-e-e, p-e-r-c-u-m-a). Do not add fine amounts or legal claims.
8. Do not change the approved copy below. A small fit-to-group tweak (for example dropping the link) is allowed only if you show it to the owner first.
9. Computer use is a last resort for the browser: prefer Claude in Chrome / the built-in browser for web pages; use computer use for the native file picker and anything the browser tools cannot reach.

## 3. Steps

### A. Find candidates
- [ ] Open facebook.com -> Groups -> "Your groups". List groups the owner follows with "JB", "Johor", "Johor Bahru", "Skudai", "Iskandar", "Tebrau" in the name.
- [ ] For each of 4 to 6 candidates record: name, public or private (shown under the name), member count, last-24h activity.
- [ ] Drop private groups and any group that looks inactive or spammy.

### B. Study the rules (per candidate)
- [ ] Open About and read the rules in full. Note the exact wording for: promotion/self-ads, links, images, language, "admin approval required", posting frequency, and anything about apps.
- [ ] Check whether posts need admin approval (look for "Pending posts" notes or the post box wording).
- [ ] Decide: **OK to post / skip / OK only without the link**. Write the reason as a quote from the rules.

### C. Shortlist and ask
- [ ] Pick the 2 best public groups where the answer is OK. Pick the language by the group: Malay (M1) for a Malay-language group, Chinese (C1) for a Chinese-language group, otherwise ask the owner.
- [ ] Show the owner a table: group, public/private, relevant rule quotes, language, decision. **Wait for OK.**

### D. Post (only after the OK, one group at a time)
- [ ] Open the group, click the post box, paste the approved text (section 4), attach the matching image from the owner's computer through the file picker.
- [ ] Use the tracked link with the group's name in `utm_content` (no spaces; e.g. `JB-Kaki-Parking`).
- [ ] If the group allows links: link in the post text. If links are banned but images are fine: image only, and skip the link. Say which one was done.
- [ ] Screenshot the composer, ask the owner for a final "post" if not already given for this exact text, press Post.
- [ ] Screenshot the result. Note whether it posted, went to "pending admin approval", or was blocked.

### E. Report back
- [ ] Reply with: groups checked, the rule quotes for each decision, what was posted where (with the post link), pending or blocked status, any Facebook warnings.
- [ ] Do not post anywhere else. Suggest what to watch next: GA4 for `utm_campaign=softlaunch` (use the GA UI, the analytics MCP is read-only and may be down), and replies in the post.
- [ ] Update the Notion page "Cowork Job 5: soft-launch posts (fan page + 5 communities)" with: groups tested, rules found, result.

## 4. Approved copy (do not edit)

Replace `GROUPNAME` with the group's name, no spaces. Use `utm_medium=group`.

### Chinese (C1), image `tolong-alih-softlaunch-zh-c1.png`

```
不挡人财路，Block 车也不怕被骂 🚗

临时 double park？用 Tolong Alih 输入车牌，对方马上收到通知。你的电话号码不用给陌生人，半夜也不会被 call。

一个人做的小 app，试用中，欢迎试试看，有问题直接告诉我 🙏
👉 https://alih.nextnovas.com/start.html?utm_source=facebook&utm_medium=group&utm_campaign=softlaunch&utm_content=GROUPNAME
```

### Malay (M1), image `tolong-alih-softlaunch-ms-m1.png`

```
Kena block? Tak payah bengang. 🚗

Taip plat, pemandu tu terus dapat notis. Nombor anda tak payah bagi kat orang tak kenal, dan tak ada panggilan pukul 2 pagi.

Tolong Alih ialah app kecil buatan sorang-sorang, tengah soft launch. Cubalah, dan beritahu saya kalau ada masalah 🙏
👉 https://alih.nextnovas.com/start.html?utm_source=facebook&utm_medium=group&utm_campaign=softlaunch&utm_content=GROUPNAME
```

Why the link goes to `start.html`: the site root drops the query string for first-time visitors, so the UTM tags would be lost.

## 5. Change the wording later

Edit the `COPY` block at the top of `scripts/marketing-ads.mjs` and run `node scripts/marketing-ads.mjs`. It rebuilds both 1080x1080 PNGs in `public/marketing/`.

## 6. Context

- App: Tolong Alih (alih.nextnovas.com), a Malaysian double-parking resolution app by Next Novas. Type the other car's plate, the blocked driver is notified, no phone number exchanged.
- Soft launch, solo project, no hard sell, audience Malaysia only, at most 2 community posts a day, no paid boosts.
- Chinese copy is casual (mixes English, lah/leh). Malay copy follows Malaysian Malay culture (adab, bengang, wary of strangers having your number). They are written separately on purpose.
- Notion pages (private "Tolong Alih" page): "Marketing workflow and assets" (the Canva link there is obsolete), "Facebook copywriting (EN / BM / 中文)", "Cowork Job 5: soft-launch posts (fan page + 5 communities)" (still lists the old images; the two above replace them).
