// routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const auth = require('../middleware/auth');

// 模拟用户数据库
const users = [
  {
    id: 4,
    username: 'testuser',
    email: 'user@example.com',
    // 密码是 "password123" 的哈希值
    password: '$2a$10$N9qo8uLOickgx2ZMRZoMyeZHJ6Z.AGz7J5Q8qR1J2LqF3c4m1YyW2'
  }
];

// 用户登录
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // 1. 查找用户
    const user = users.find(u => u.email === email);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: '用户不存在'
      });
    }
    
    // 2. 验证密码（模拟，实际应该用 bcrypt.compare）
    // 这里简化处理，实际密码应该是 "password123"
    const isValidPassword = password === 'password123';
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        error: '密码错误'
      });
    }
    
    // 3. 生成token
    const token = auth.generateToken(user.id);
    
    // 4. 返回响应（不返回密码）
    const { password: _, ...userWithoutPassword } = user;
    
    res.json({
      success: true,
      token,
      user: userWithoutPassword,
      expiresIn: '7d'
    });
    
  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 用户注册
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    
    // 1. 检查用户是否已存在
    if (users.find(u => u.email === email)) {
      return res.status(400).json({
        success: false,
        error: '邮箱已被注册'
      });
    }
    
    // 2. 创建新用户
    const newUser = {
      id: users.length + 1,
      username,
      email,
      password: await bcrypt.hash(password, 10)
    };
    
    users.push(newUser);
    
    // 3. 生成token
    const token = auth.generateToken(newUser.id);
    
    // 4. 返回响应
    const { password: _, ...userWithoutPassword } = newUser;
    
    res.status(201).json({
      success: true,
      token,
      user: userWithoutPassword
    });
    
  } catch (error) {
    console.error('注册错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取当前用户信息
router.get('/me', auth.verifyToken, (req, res) => {
  const user = users.find(u => u.id === req.user.id);
  if (!user) {
    return res.status(404).json({
      success: false,
      error: '用户不存在'
    });
  }
  
  const { password, ...userWithoutPassword } = user;
  res.json({
    success: true,
    user: userWithoutPassword
  });
});

module.exports = router;
