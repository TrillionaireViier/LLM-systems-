    switch (provider) {
      case 'runway':
        return await handleRunway(payload, res);
      case 'pika':
        return await handlePika(payload, res);
      case 'synthesia':
        return await handleSynthesia(payload, res);
      case 'openai_video':
        return await handleOpenAIVideo(payload, res);
      case 'gemini':
      case 'google':
        return await handleGemini(payload, res);
      default:
        return res.status(400).json({ error: 'Unsupported provider: ' + provider });
    }
