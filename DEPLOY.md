# نشر صدى على الإنترنت — Deploy Sada to the Internet

> **لماذا ليس GitHub Pages؟** Pages يستضيف ملفات ثابتة فقط (HTML/CSS/JS) ولا
> يشغّل أي كود خادمي. منصة صدى تحتاج: API خادمي (87 مساراً) + قاعدة بيانات +
> خادم WebSocket + معالجات خلفية + أسرار الإيميل — لذلك النشر الحقيقي يكون على
> منصة حاويات. *(Why not GitHub Pages: it serves static files only — Sada
> needs a server runtime, database, WebSocket gateway and secrets.)*

المنصة تُنشر كصورة Docker واحدة تجمع **web + realtime + worker** معاً (حتى
تتشارك قاعدة SQLite واحدة بأمان على نفس القرص). كل ما يلي يقرأه النشر تلقائياً
من المستودع — لا حاجة لتعديل أي شيء يدوياً.

---

## الخيار 1: Railway (موصى به — قرص دائم)

1. افتح https://railway.app وسجّل الدخول **بحساب GitHub**.
2. **New Project** ← **Deploy from GitHub repo** ← اختر `worldnewsportal/sada`.
3. Railway يقرأ `railway.json` تلقائياً (يبني `Dockerfile.all-in-one` ويفحص
   `/api/v1/health`).
4. داخل الخدمة: **Volumes** ← **New Volume** ← مسار التحميل `/app/data`
   (يحفظ قاعدة البيانات والوسائط عبر عمليات النشر).
5. (اختياري) **Variables**: أضف مفاتيح الإيميل `SMTP_HOST/SMTP_PORT/SMTP_USER/
   SMTP_PASS/EMAIL_CHAIN` (انظر README §Email delivery). الأسرار
   (JWT_SECRET…) تُولَّد وتُحفَظ تلقائياً على القرص إن لم تُزوَّد.
6. **Settings → Networking → Generate Domain** ← ستحصل على رابط
   `https://…up.railway.app` يعمل فوراً.

## الخيار 2: Render (زر بنقرة واحدة)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/worldnewsportal/sada)

1. اضغط الزر أعلاه ← سجّل الدخول بحساب GitHub ← يقرأ Render ملف `render.yaml`.
2. اضغط **Apply** ← يبني وينشر ويعطيك رابط `https://…onrender.com`.
3. ⚠️ ملاحظة صادقة: خطة Render **المجانية بلا قرص دائم** — البيانات تُصفَّر مع
   كل إعادة نشر. للدوام: غيّر `plan: starter` في `render.yaml` (≈7$/شهر)
   ليُفعِّل القرص المرفق تلقائياً.

## ماذا يحدث عند أول إقلاع؟ (تلقائي بالكامل)

| الخطوة | التفاصيل |
|---|---|
| مزامنة المخطط | `prisma db push` ينشئ كل الجداول في SQLite على القرص الدائم |
| توليد الأسرار | `JWT_SECRET` / `INTERNAL_SECRET` / `APP_PEPPER` تُولَّد وتُحفَظ على القرص |
| الخدمات الثلاث | web (:3000) + realtime (:3003 داخلياً) + worker (polling) |
| الفحص الصحي | `/api/v1/health` — المنصة لا تُعلن الجاهزية قبله |

## تجربة سريعة بعد النشر (نموذج تجريبي مفعّل)

افتح الرابط ← سجّل برقم تجريبي مثل `+999501111111` ← يظهر رمز التفعيل داخل
الشاشة فوراً (وضع `ALLOW_TEST_PHONES=true` المضبوط في render.yaml؛ فعّله في
Railway بنفس الاسم) ← أكمل الملف الشخصي ← الدردشة تعمل لحظياً. للإطلاق الحقيقي:
أوقف `ALLOW_TEST_PHONES` وأضف بوابة SMS أو اعتمد تسجيل الإيميل بمفاتيح SMTP.

## تحديث المنصة لاحقاً

كل `bun run deploy` على جهازك = دفع إلى GitHub = إعادة نشر تلقائية على
Railway/Render + تشغيل CI كاملاً (45 اختبار + بناء الصور).

## ترقية مستقبلية (حجم أكبر)

عند الحاجة لـ Postgres + Redis + MinIO + عدة نسخ: ملف
`infrastructure/docker-compose.yml` جاهز لخادم VPS واحد بأمر
`docker compose --env-file .env up -d --build` (يتطلب تحويل مخطط Prisma
لمزوّد postgres — موثق في `docs/deployment.md`).
