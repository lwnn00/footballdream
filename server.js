const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS 中间件
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// 亚洲足球推荐 API
app.get('/api/recommend/asian', (req, res) => {
  const { league = 'all', limit = 5 } = req.query;
  
  const data = [
    {
      id: 1,
      league: "英超",
      match: "曼城 vs 利物浦",
      tip: "大球 (2.5+)",
      odds: 1.85,
      confidence: 85
    },
    {
      id: 2,
      league: "中超",
      match: "上海海港 vs 山东泰山",
      tip: "主胜",
      odds: 2.10,
      confidence: 72
    }
  ];
  
  let filtered = data;
  if (league !== 'all') {
    filtered = data.filter(item => item.league.includes(league));
  }
  filtered = filtered.slice(0, parseInt(limit));
  
  res.json({
    success: true,
    data: filtered,
    count: filtered.length
  });
});

// 也支持 POST 请求
app.post('/api/recommend/asian', (req, res) => {
  const { league = 'all', limit = 5 } = req.body;
  
  const data = [
    {
      id: 1,
      league: "英超",
      match: "曼城 vs 利物浦",
      tip: "大球 (2.5+)",
      odds: 1.85,
      confidence: 85
    }
  ];
  
  res.json({
    success: true,
    data: data,
    method: 'POST',
    params: req.body
  });
});

// 404 处理
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.originalUrl
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`🚀 服务器运行在 http://localhost:${PORT}`);
  console.log(`📡 API 端点:`);
  console.log(`   GET  /api/health`);
  console.log(`   GET  /api/recommend/asian`);
  console.log(`   POST /api/recommend/asian`);
});
