# cubecv.site

صفحة الهبوط cubecv.site على CranL، مع تتبع TikTok (Pixel + Events API) ولوحة متابعة على `/admin`.
مستقل تمامًا عن cubecv.store وتطبيق cubecv-landing-trial وقاعدته.

- `public/index.html`: الصفحة كما هي على Netlify، مع سكربت التتبع فقط (لا تغيير مرئي).
- `public/admin/index.html`: لوحة المتابعة.
- `server.mjs`: خادم Node على المنفذ 8080، و`/healthz` لفحص الحالة.
- `src/handlers/`: `tiktok-contact` (Events API + تسجيل الضغطة)، `track-view`، `admin-api`.
- `src/store.mjs`: PostgreSQL؛ الجداول تُنشأ تلقائيًا عند التشغيل.

## متغيرات البيئة (في CranL فقط، لا تُرفع إلى المستودع)

| المتغير | إلزامي |
|---|---|
| `DATABASE_URL` | نعم: رابط قاعدة PostgreSQL الخاصة بهذا التطبيق |
| `TIKTOK_EVENTS_API_ACCESS_TOKEN` | نعم |
| `ADMIN_EMAIL` | نعم |
| `ADMIN_PASSWORD` | نعم |
| `ADMIN_SESSION_SECRET` | لا |
| `TIKTOK_TEST_EVENT_CODE` | لا: للاختبار فقط |

## الاختبارات

```
npm install
npm test
```

تعمل على PostgreSQL داخل العملية (PGlite) مع محاكاة TikTok، بدون شبكة.

## الخصوصية

لا يُخزَّن IP ولا أرقام هواتف ولا محتوى رسائل. يُرسل إلى TikTok فقط: event_id وttclid و_ttp وIP وUser Agent ورابط الصفحة.
