
const express = require('express');
const { Client, types } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 8000;

const client = new Client({
	api_key: 'sk-0Cs8T56GGMGcIkKjIqP3Ug',
	http_options: new types.HttpOptions({ base_url: 'https://hubai.loe.gg' })
});

app.get('/health', (req, res) => res.send('OK'));

app.get('/ask', async (req, res) => {
	try {
		const response = await client.models.generate_content({
			model: 'gemini-2.0-flash-lite',
			contents: 'Why is the sky blue?'
		});
		res.send(response.text);
	} catch (e) {
		res.status(500).send(e.message || 'Error');
	}
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
