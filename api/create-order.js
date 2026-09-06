// api/create-order.js
// Vercel Serverless Function — يدعم صفحة iPhone الحالية وصفحة RW-81 في نفس Shopify Draft Orders.

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken(shop, clientId, clientSecret) {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60_000) return cachedToken;

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

function isValidPhone(phone) {
  return typeof phone === 'string' && /^(0)(5|6|7)[0-9]{8}$/.test(phone.replace(/\s+/g, ''));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

  const SHOP = process.env.SHOPIFY_SHOP;
  const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
  const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
  const API_VERSION = '2025-10';

  if (!SHOP || !CLIENT_ID || !CLIENT_SECRET) {
    console.error('Missing SHOPIFY_SHOP / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET env vars');
    return res.status(500).json({ message: 'خطأ في إعدادات الخادم.' });
  }

  const body = req.body || {};
  const {
    name, phone, wilaya, commune, address,
    phoneModel, variantId, colorLabel,
    product, deliveryType, shippingPrice, productPrice, totalPrice
  } = body;

  const cleanName = typeof name === 'string' ? name.trim() : '';
  const cleanPhone = typeof phone === 'string' ? phone.replace(/\s+/g, '') : '';
  const cleanWilaya = typeof wilaya === 'string' ? wilaya.trim() : '';
  const cleanCommune = typeof commune === 'string' ? commune.trim() : '';
  const cleanAddress = typeof address === 'string' ? address.trim() : '';

  if (!cleanName || cleanName.length < 3 || !isValidPhone(cleanPhone) || !cleanWilaya || !cleanCommune) {
    return res.status(400).json({ message: 'البيانات المرسلة غير صحيحة أو غير مكتملة.' });
  }

  const isRW81 = product === 'RW-81';
  const ALLOWED_VARIANTS = ['44154901987402', '44154902020170', '44154902052938', '44154902085706'];

  // الصفحة القديمة: لا نغيّر منطقها.
  if (!isRW81) {
    if (!cleanAddress || !variantId || !ALLOWED_VARIANTS.includes(String(variantId))) {
      return res.status(400).json({ message: 'البيانات المرسلة غير صحيحة أو غير مكتملة.' });
    }
  }

  let lineItems;
  let shippingLine = undefined;
  let customAttributes;
  let note;
  let tags;
  let shippingAddress;

  if (isRW81) {
    const price = Number(productPrice);
    const ship = Number(shippingPrice);
    const total = Number(totalPrice);

    if (!Number.isFinite(price) || price <= 0 || price > 100000 ||
        !Number.isFinite(ship) || ship < 0 || ship > 100000 ||
        !Number.isFinite(total) || total !== price + ship ||
        !cleanAddress || !deliveryType) {
      return res.status(400).json({ message: 'بيانات طلب الساعة غير صحيحة أو غير مكتملة.' });
    }

    // Custom line item: لا يحتاج Variant ID خاص بالساعة.
    lineItems = [{
      title: 'HainoTeko Germany RW-81',
      quantity: 1,
      originalUnitPrice: String(price),
      requiresShipping: true,
      taxable: false,
      customAttributes: [
        { key: 'المنتج', value: 'RW-81' }
      ]
    }];

    shippingLine = {
      title: String(deliveryType),
      price: String(ship)
    };

    customAttributes = [
      { key: 'المنتج', value: 'RW-81' },
      { key: 'الاسم', value: cleanName },
      { key: 'الهاتف', value: cleanPhone },
      { key: 'الولاية', value: cleanWilaya },
      { key: 'البلدية', value: cleanCommune },
      { key: 'العنوان', value: cleanAddress },
      { key: 'نوع التوصيل', value: String(deliveryType) },
      { key: 'سعر المنتج', value: `${price} دج` },
      { key: 'سعر التوصيل', value: `${ship} دج` },
      { key: 'المجموع', value: `${total} دج` },
      { key: 'طريقة الدفع', value: 'الدفع عند الاستلام' }
    ];

    note = `طلب RW-81 من صفحة الهبوط — الدفع عند الاستلام — المجموع ${total} دج`;
    tags = ['COD', 'Landing Page', 'RW-81'];
    shippingAddress = {
      firstName: cleanName,
      lastName: '',
      phone: cleanPhone,
      address1: cleanAddress,
      city: cleanCommune,
      province: cleanWilaya,
      country: 'Algeria'
    };
  } else {
    lineItems = [
      { variantId: `gid://shopify/ProductVariant/${variantId}`, quantity: 1 }
    ];

    customAttributes = [
      { key: 'الاسم', value: cleanName },
      { key: 'الهاتف', value: cleanPhone },
      { key: 'الولاية', value: cleanWilaya },
      { key: 'البلدية', value: cleanCommune },
      { key: 'العنوان', value: cleanAddress },
      { key: 'الطراز', value: phoneModel || '' },
      { key: 'اللون', value: colorLabel || '' },
      { key: 'طريقة الدفع', value: 'الدفع عند الاستلام' }
    ];

    note = 'طلب من صفحة الهبوط — الدفع عند الاستلام (COD)';
    tags = ['COD', 'Landing Page'];
    shippingAddress = {
      firstName: cleanName,
      lastName: '',
      phone: cleanPhone,
      address1: cleanAddress,
      city: cleanCommune,
      province: cleanWilaya,
      country: 'Algeria'
    };
  }

  const mutation = `
    mutation draftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder { id name }
        userErrors { field message }
      }
    }
  `;

  const input = {
    lineItems,
    note,
    customAttributes,
    tags,
    shippingAddress
  };

  if (shippingLine) input.shippingLine = shippingLine;

  try {
    const accessToken = await getAccessToken(SHOP, CLIENT_ID, CLIENT_SECRET);

    const shopifyRes = await fetch(`https://${SHOP}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken
      },
      body: JSON.stringify({ query: mutation, variables: { input } })
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
