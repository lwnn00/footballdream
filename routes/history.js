// routes/history.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');

// 获取用户历史记录
router.get('/', auth.verifyToken, async (req, res) => {
  try {
    const userId = req.query.userId;
    
    console.log('请求用户ID:', userId);
    console.log('认证用户ID:', req.user.id);
    
    // 验证权限：用户只能访问自己的历史记录
    if (parseInt(userId) !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: '无权访问',
        message: '只能查看自己的历史记录',
        requestedId: userId,
        authenticatedId: req.user.id
      });
    }
    
    // 模拟数据库查询
    const mockHistory = [
      { id: 1, userId: 4, action: '登录系统', timestamp: '2026-01-14 10:00:00' },
      { id: 2, userId: 4, action: '查看产品', timestamp: '2026-01-14 10:30:00' },
      { id: 3, userId: 4, action: '下单购买', timestamp: '2026-01-14 11:00:00' }
    ];
    
    res.json({
      success: true,
      data: mockHistory,
      count: mockHistory.length,
      user: { id: req.user.id }
    });
    
  } catch (error) {
    console.error('获取历史记录错误:', error);
    res.status(500).json({
      success: false,
      error: '服务器错误',
      message: error.message
    });
  }
});

// 可选：公开的历史记录（不需要认证）
router.get('/public', (req, res) => {
  res.json({
    success: true,
    data: [
      { id: 1, action: '公共活动1', timestamp: '2026-01-01' },
      { id: 2, action: '公共活动2', timestamp: '2026-01-02' }
    ],
    message: '这是公开的历史记录，无需认证'
  });
});

module.exports = router;
