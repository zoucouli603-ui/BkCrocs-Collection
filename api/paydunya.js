const PAYDUNYA_PRODUCTION_URL = 'https://app.paydunya.com/api/v1/checkout-invoice/create';
const PAYDUNYA_SANDBOX_URL = 'https://app.paydunya.com/sandbox-api/v1/checkout-invoice/create';

function sendJson(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function getSiteOrigin(req) {
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `${protocol}://${host}` : 'http://localhost:3000';
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
    throw new Error('La commande doit contenir entre 1 et 50 articles.');
  }

  return items.map((item) => {
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const size = typeof item.size === 'string' ? item.size.trim() : '';
    const quantity = Number(item.quantity);
    const unitPrice = Number(item.unit_price);

    if (!name || !size || !Number.isInteger(quantity) || quantity < 1 || quantity > 99 ||
        !Number.isInteger(unitPrice) || unitPrice < 1) {
      throw new Error('Un article contient des informations invalides.');
    }

    return { name, size, quantity, unit_price: unitPrice };
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Méthode non autorisée.' });
  }

  // Collez vos clés (tableau de bord PayDunya > Intégrer > votre application) dans
  // Vercel > Settings > Environment Variables :
  //   PAYDUNYA_MASTER_KEY, PAYDUNYA_PRIVATE_KEY, PAYDUNYA_TOKEN
  // Optionnel : PAYDUNYA_ENV=sandbox (mode test), PAYDUNYA_RETURN_URL, PAYDUNYA_CANCEL_URL.
  // Ne les écrivez jamais dans index.html, Git ou une autre ressource publique.
  const masterKey = process.env.PAYDUNYA_MASTER_KEY;
  const privateKey = process.env.PAYDUNYA_PRIVATE_KEY;
  const token = process.env.PAYDUNYA_TOKEN;

  if (!masterKey || !privateKey || !token) {
    return sendJson(res, 500, {
      error: 'PayDunya n’est pas configuré. Ajoutez PAYDUNYA_MASTER_KEY, PAYDUNYA_PRIVATE_KEY et PAYDUNYA_TOKEN dans Vercel.'
    });
  }

  try {
    const body = req.body || {};
    const totalAmount = Number(body.total_amount);
    const customerName = typeof body.customer_name === 'string' ? body.customer_name.trim() : '';
    const customerPhone = typeof body.customer_phone === 'string' ? body.customer_phone.trim() : '';
    const items = normalizeItems(body.items);

    if (!Number.isInteger(totalAmount) || totalAmount < 1 || totalAmount > 100000000) {
      throw new Error('Le montant de la commande est invalide.');
    }
    if (!customerName || customerName.length > 120 || !customerPhone || customerPhone.length > 30) {
      throw new Error('Le nom et le téléphone du client sont obligatoires.');
    }
    const computedTotal = items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
    if (computedTotal !== totalAmount) {
      throw new Error('Le total de la commande ne correspond pas aux articles envoyés.');
    }

    const origin = getSiteOrigin(req);
    const returnUrl = process.env.PAYDUNYA_RETURN_URL || `${origin}/?status=success`;
    const cancelUrl = process.env.PAYDUNYA_CANCEL_URL || `${origin}/?status=cancelled`;
    // Utilisez PAYDUNYA_ENV=sandbox pour tester, puis retirez-le ou passez en production.
    const apiUrl = process.env.PAYDUNYA_ENV === 'sandbox'
      ? PAYDUNYA_SANDBOX_URL
      : (process.env.PAYDUNYA_API_URL || PAYDUNYA_PRODUCTION_URL);

    // PayDunya facture en Francs CFA (XOF) : les montants sont des entiers, sans décimales.
    const payload = {
      invoice: {
        items: Object.fromEntries(items.map((item, index) => [`item_${index}`, {
          name: `${item.name} (pointure ${item.size})`,
          quantity: item.quantity,
          unit_price: String(item.unit_price),
          total_price: String(item.unit_price * item.quantity),
          description: `Pointure ${item.size}`
        }])),
        total_amount: totalAmount,
        description: `Commande Bk Collection Mali - ${customerName}`
      },
      store: {
        name: 'Bk Collection Mali',
        website_url: origin
      },
      custom_data: {
        customer_name: customerName,
        customer_phone: customerPhone,
        items
      },
      actions: {
        return_url: returnUrl,
        cancel_url: cancelUrl
      }
    };

    const paydunyaResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAYDUNYA-MASTER-KEY': masterKey,
        'PAYDUNYA-PRIVATE-KEY': privateKey,
        'PAYDUNYA-TOKEN': token
      },
      body: JSON.stringify(payload)
    });

    const responseBody = await paydunyaResponse.json();
    const paymentUrl = responseBody.response_text || responseBody.responseText || responseBody.url;

    if (!paydunyaResponse.ok || !paymentUrl) {
      console.error('PayDunya invoice creation failed', {
        status: paydunyaResponse.status,
        response: responseBody
      });
      return sendJson(res, 502, { error: 'PayDunya n’a pas pu créer la facture.', details: responseBody.description || responseBody.message });
    }

    return sendJson(res, 200, { payment_url: paymentUrl });
  } catch (error) {
    console.error('PayDunya request validation failed', error);
    return sendJson(res, 400, { error: error.message || 'Requête de paiement invalide.' });
  }
};
