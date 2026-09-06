// api/create-order.js
// Serverless Function (Vercel) — يستقبل بيانات استمارة صفحة الهبوط وينشئ Draft Order في شوبيفاي.
//
// منذ 1 يناير 2026، تطبيقات Dev Dashboard لا تُعطي توكن ثابت، بل Client ID + Client Secret.
// هذه الدالة تبادلهما تلقائيًا للحصول على access_token صالح 24 ساعة (client_credentials grant)،
// ثم تستخدمه لإنشاء الطلب عبر GraphQL Admin API. كل هذا يحدث على الخادم فقط،
// الـ Client Secret لا يظهر أبدًا في المتصفح.

// كاش بسيط داخل ذاكرة الدالة (يفيد فقط إذا أعيد استخدام نفس الـ instance، وإلا يُطلب توكن جديد تلقائيًا — لا مشكلة)
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken(shop, clientId, clientSecret) {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const tokenRes = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    })
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Token request failed (${tokenRes.status}): ${errText}`);
  }

  const tokenData = await tokenRes.json();
  cachedToken = tokenData.access_token;
  cachedTokenExpiresAt = Date.now() + tokenData.expires_in * 1000;
  return cachedToken;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  const SHOP = process.env.SHOPIFY_SHOP;                 // مثال: bd5ia1-rc  (بدون .myshopify.com)
  const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
  const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
  const API_VERSION = '2025-10';

  if (!SHOP || !CLIENT_ID || !CLIENT_SECRET) {
    console.error('Missing SHOPIFY_SHOP / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET env vars');
    return res.status(500).json({ message: 'خطأ في إعدادات الخادم.' });
  }

  const body = req.body || {};
  const { name, phone, wilaya, commune, phoneModel, variantId, colorLabel } = body;

  // تحقق صارم من البيانات على الخادم
  const phoneOk = typeof phone === 'string' && /^(0)(5|6|7)[0-9]{8}$/.test(phone.replace(/\s+/g, ''));
  const ALLOWED_VARIANTS = ['44154901987402', '44154902020170', '44154902052938', '44154902085706'];

  if (
    !name || typeof name !== 'string' || name.trim().length < 3 ||
    !phoneOk ||
    !wilaya || typeof wilaya !== 'string' ||
    !commune || typeof commune !== 'string' ||
    !variantId || !ALLOWED_VARIANTS.includes(String(variantId))
  ) {
    return res.status(400).json({ message: 'البيانات المرسلة غير صحيحة أو غير مكتملة.' });
  }

  const mutation = `
    mutation draftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder { id name }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    input: {
      lineItems: [
        { variantId: `gid://shopify/ProductVariant/${variantId}`, quantity: 1 }
      ],
      note: 'طلب من صفحة الهبوط — الدفع عند الاستلام (COD)',
      customAttributes: [
        { key: 'الاسم', value: name.trim() },
        { key: 'الهاتف', value: phone.trim() },
        { key: 'الولاية', value: wilaya },
        { key: 'البلدية', value: commune.trim() },
        { key: 'الطراز', value: phoneModel || '' },
        { key: 'اللون', value: colorLabel || '' },
        { key: 'طريقة الدفع', value: 'الدفع عند الاستلام' }
      ],
      tags: ['COD', 'Landing Page'],
      shippingAddress: {
        firstName: name.trim(),
        lastName: '',
        phone: phone.trim(),
        address1: commune.trim(),
        city: commune.trim(),
        province: wilaya,
        country: 'Algeria'
      }
    }
  };

  try {
    const accessToken = await getAccessToken(SHOP, CLIENT_ID, CLIENT_SECRET);

    const shopifyRes = await fetch(`https://${SHOP}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken
      },
      body: JSON.stringify({ query: mutation, variables })
    });

    const shopifyData = await shopifyRes.json();
    const userErrors = shopifyData?.data?.draftOrderCreate?.userErrors;

    if (!shopifyRes.ok || (userErrors && userErrors.length > 0) || shopifyData.errors) {
      console.error('Shopify API error:', JSON.stringify(shopifyData));
      return res.status(502).json({
        message: 'تعذّر إنشاء الطلب في شوبيفاي.',
        details: userErrors || shopifyData.errors
      });
    }

    return res.status(200).json({
      success: true,
      order_id: shopifyData.data.draftOrderCreate.draftOrder.id
    });
  } catch (err) {
    console.error('Unexpected error creating draft order:', err);
    return res.status(500).json({ message: 'حدث خطأ غير متوقع أثناء إرسال الطلب.' });
  }
}
