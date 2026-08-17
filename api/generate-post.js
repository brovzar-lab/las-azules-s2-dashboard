const Anthropic = require('@anthropic-ai/sdk');

const HASHTAGS = '#LasAzules #WomenInBlue #AppleTV #LasAzulesS2';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { headline, excerpt, publication, url, language } = req.body || {};

  if (!headline) {
    res.status(400).json({ error: 'headline is required' });
    return;
  }

  const lang = language === 'en' ? 'en' : 'es';
  const excerptClause = excerpt ? ` Excerpt: "${excerpt.substring(0, 200)}".` : '';
  const sourceClause = publication ? ` Source: ${publication}.` : '';

  const prompt = lang === 'es'
    ? `Eres el community manager de Las Azules S2, un drama de Apple TV+. Escribe un post punchero y atractivo en español para compartir este artículo en Instagram o Twitter. Incluye 2-3 hashtags de los siguientes: ${HASHTAGS}. Artículo: ${headline}.${excerptClause}${sourceClause} Máximo 280 caracteres. Devuelve solo el texto del post, sin explicación.`
    : `You are the social media manager for Las Azules S2, a prestige drama on Apple TV+. Write a punchy, engaging post in English to share this article on Instagram or Twitter. Include 2-3 hashtags from: ${HASHTAGS}. Article: ${headline}.${excerptClause}${sourceClause} Keep it under 280 characters. Return only the post text, no explanation.`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 350,
      messages: [{ role: 'user', content: prompt }],
    });

    const post = message.content[0].text.trim();
    res.status(200).json({ post });
  } catch (err) {
    console.error('Claude API error:', err.message || err);
    res.status(500).json({ error: 'Failed to generate post' });
  }
};
