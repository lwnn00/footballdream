// ==================== server.js - Vercel + Neon 完整版 ====================
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

// 创建 Express 应用
const app = express();

// ==================== 数据库配置 ====================
let pool;

try {
  // Neon PostgreSQL 连接配置
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    },
    max: 20, // 最大连接数
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  console.log('✅ 数据库连接池创建成功');
  
  // 测试数据库连接
  pool.query('SELECT NOW()', (err, res) => {
    if (err) {
      console.error('❌ 数据库连接测试失败:', err.message);
    } else {
      console.log('✅ 数据库连接测试成功:', res.rows[0].now);
    }
  });
} catch (error) {
  console.error('❌ 数据库连接配置失败:', error.message);
  process.exit(1);
}

// ==================== 中间件配置 ====================
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://dream-lilac.vercel.app',
    'https://footballdream.vercel.app'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 请求日志中间件
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ==================== 数据库初始化函数 ====================
async function initializeDatabase() {
  try {
    // 创建用户表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP,
        CONSTRAINT valid_role CHECK (role IN ('user', 'admin'))
      );
    `);

    // 创建历史记录表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_history (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        action VARCHAR(100) NOT NULL,
        details TEXT,
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 创建索引
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_history_user_id ON user_history(user_id);
      CREATE INDEX IF NOT EXISTS idx_history_created_at ON user_history(created_at DESC);
    `);

    console.log('✅ 数据库表初始化完成');
    
    // 插入测试数据（仅当表为空时）
    const usersCount = await pool.query('SELECT COUNT(*) FROM users');
    if (parseInt(usersCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO users (username, email, password_hash, role) 
        VALUES 
          ('testuser', 'user@example.com', '$2a$10$N9qo8uLOickgx2ZMRZoMyeZHJ6Z.AGz7J5Q8qR1J2LqF3c4m1YyW2', 'user'),
          ('admin', 'admin@example.com', '$2a$10$N9qo8uLOickgx2ZMRZoMyeZHJ6Z.AGz7J5Q8qR1J2LqF3c4m1YyW2', 'admin')
        ON CONFLICT (email) DO NOTHING;
      `);
      
      console.log('✅ 测试用户数据插入完成');
    }

  } catch (error) {
    console.error('❌ 数据库初始化失败:', error);
  }
}

// 调用初始化
initializeDatabase();

// ==================== 认证中间件 ====================
const authMiddleware = {
  // JWT验证中间件（简化版）
  verifyToken: async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
          success: false,
          error: '需要认证令牌',
          code: 'MISSING_TOKEN'
        });
      }

      const token = authHeader.split(' ')[1];
      
      // 这里应该使用 jwt.verify()，暂时简化
      // 在实际应用中，你应该：
      // 1. 验证JWT token
      // 2. 从数据库检查用户状态
      
      // 临时方案：直接假设用户ID为4（测试用）
      req.user = { id: 4, username: 'testuser' };
      
      // 验证用户是否存在
      const userResult = await pool.query(
        'SELECT id, username, email, role FROM users WHERE id = $1',
        [req.user.id]
      );
      
      if (userResult.rows.length === 0) {
        return res.status(401).json({
          success: false,
          error: '用户不存在',
          code: 'USER_NOT_FOUND'
        });
      }
      
      req.user = userResult.rows[0];
      next();
      
    } catch (error) {
      console.error('认证错误:', error);
      res.status(401).json({
        success: false,
        error: '认证失败',
        code: 'AUTH_ERROR'
      });
    }
  }
};

// ==================== 健康检查路由 ====================
app.get('/', async (req, res) => {
  try {
    // 检查数据库连接
    const dbCheck = await pool.query('SELECT NOW() as time');
    
    res.json({
      success: true,
      message: 'FootballDream API 运行正常',
      data: {
        server: {
          environment: process.env.NODE_ENV || 'development',
          timestamp: new Date().toISOString(),
          uptime: process.uptime()
        },
        database: {
          connected: true,
          time: dbCheck.rows[0].time
        },
        endpoints: {
          health: '/health',
          history: '/api/history',
          auth: '/api/auth'
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: '数据库连接失败',
      message: error.message
    });
  }
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'healthy',
      database: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message
    });
  }
});

// ==================== API路由 ====================

// 1. 历史记录相关路由
const historyRouter = express.Router();

// 获取用户历史记录（需要认证）
historyRouter.get('/', authMiddleware.verifyToken, async (req, res) => {
  try {
    const userId = req.query.userId || req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    // 验证用户权限
    if (req.user.role !== 'admin' && parseInt(userId) !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: '无权访问其他用户的历史记录'
      });
    }

    // 获取历史记录
    const historyQuery = `
      SELECT 
        id, user_id, action, details, 
        ip_address, user_agent, created_at
      FROM user_history 
      WHERE user_id = $1 
      ORDER BY created_at DESC 
      LIMIT $2 OFFSET $3
    `;

    const countQuery = `
      SELECT COUNT(*) as total 
      FROM user_history 
      WHERE user_id = $1
    `;

    const [historyResult, countResult] = await Promise.all([
      pool.query(historyQuery, [userId, limit, offset]),
      pool.query(countQuery, [userId])
    ]);

    const total = parseInt(countResult.rows[0].total);

    res.json({
      success: true,
      data: {
        history: historyResult.rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNext: offset + limit < total,
          hasPrev: page > 1
        }
      }
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

// 添加历史记录
historyRouter.post('/', authMiddleware.verifyToken, async (req, res) => {
  try {
    const { action, details } = req.body;
    const userId = req.user.id;

    if (!action) {
      return res.status(400).json({
        success: false,
        error: 'action字段不能为空'
      });
    }

    const insertQuery = `
      INSERT INTO user_history 
        (user_id, action, details, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, created_at
    `;

    const result = await pool.query(insertQuery, [
      userId,
      action,
      details || '',
      req.ip,
      req.headers['user-agent']
    ]);

    res.status(201).json({
      success: true,
      message: '历史记录添加成功',
      data: {
        id: result.rows[0].id,
        createdAt: result.rows[0].created_at
      }
    });

  } catch (error) {
    console.error('添加历史记录错误:', error);
    res.status(500).json({
      success: false,
      error: '添加失败',
      message: error.message
    });
  }
});

// 2. 认证相关路由
const authRouter = express.Router();

// 用户登录
authRouter.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: '邮箱和密码不能为空'
      });
    }

    // 查找用户
    const userQuery = `
      SELECT id, username, email, password_hash, role 
      FROM users 
      WHERE email = $1
    `;

    const result = await pool.query(userQuery, [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: '用户不存在'
      });
    }

    const user = result.rows[0];

    // 验证密码（实际应该使用bcrypt.compare）
    // 这里简化处理，假设密码是 "password123"
    const isValidPassword = password === 'password123';

    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        error: '密码错误'
      });
    }

    // 更新最后登录时间
    await pool.query(
      'UPDATE users SET last_login = NOW() WHERE id = $1',
      [user.id]
    );

    // 生成JWT token（简化版）
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role
      },
      process.env.JWT_SECRET || 'default_secret_key',
      { expiresIn: '7d' }
    );

    // 返回响应（不包含密码）
    const { password_hash, ...userWithoutPassword } = user;

    res.json({
      success: true,
      message: '登录成功',
      data: {
        token,
        user: userWithoutPassword,
        expiresIn: '7天'
      }
    });

  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({
      success: false,
      error: '登录失败',
      message: error.message
    });
  }
});

// 用户注册
authRouter.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({
        success: false,
        error: '请填写所有必填字段'
      });
    }

    // 检查用户是否已存在
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1 OR username = $2',
      [email, username]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        error: '邮箱或用户名已被注册'
      });
    }

    // 密码哈希（实际应该使用bcrypt）
    const bcrypt = require('bcryptjs');
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // 插入新用户
    const insertQuery = `
      INSERT INTO users (username, email, password_hash)
      VALUES ($1, $2, $3)
      RETURNING id, username, email, role, created_at
    `;

    const result = await pool.query(insertQuery, [
      username,
      email,
      passwordHash
    ]);

    // 生成token
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      {
        id: result.rows[0].id,
        email: result.rows[0].email,
        role: result.rows[0].role
      },
      process.env.JWT_SECRET || 'default_secret_key',
      { expiresIn: '7d' }
    );

    res.status(201).json({
      success: true,
      message: '注册成功',
      data: {
        token,
        user: result.rows[0]
      }
    });

  } catch (error) {
    console.error('注册错误:', error);
    res.status(500).json({
      success: false,
      error: '注册失败',
      message: error.message
    });
  }
});

// 获取当前用户信息
authRouter.get('/me', authMiddleware.verifyToken, async (req, res) => {
  try {
    const userQuery = `
      SELECT id, username, email, role, created_at, last_login
      FROM users 
      WHERE id = $1
    `;

    const result = await pool.query(userQuery, [req.user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: '用户不存在'
      });
    }

    res.json({
      success: true,
      data: {
        user: result.rows[0]
      }
    });

  } catch (error) {
    console.error('获取用户信息错误:', error);
    res.status(500).json({
      success: false,
      error: '获取失败',
      message: error.message
    });
  }
});

// ==================== 注册路由 ====================
app.use('/api/history', historyRouter);
app.use('/api/auth', authRouter);

// ==================== 临时测试路由（开发用） ====================
if (process.env.NODE_ENV !== 'production') {
  app.get('/api/test-db', async (req, res) => {
    try {
      // 测试数据库连接和查询
      const usersCount = await pool.query('SELECT COUNT(*) FROM users');
      const historyCount = await pool.query('SELECT COUNT(*) FROM user_history');
      
      res.json({
        success: true,
        data: {
          users: parseInt(usersCount.rows[0].count),
          history: parseInt(historyCount.rows[0].count),
          database_url: process.env.DATABASE_URL ? '已设置' : '未设置',
          environment: process.env.NODE_ENV
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: '数据库测试失败',
        message: error.message
      });
    }
  });

  // 临时：无需认证的历史记录查询（仅开发测试）
  app.get('/api/dev/history', async (req, res) => {
    try {
      const userId = req.query.userId || 4;
      const result = await pool.query(
        'SELECT * FROM user_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
        [userId]
      );
      
      res.json({
        success: true,
        data: result.rows,
        warning: '⚠️ 开发模式：认证已跳过'
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}

// ==================== 错误处理 ====================
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: '路由未找到',
    requestedUrl: req.originalUrl
  });
});

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({
    success: false,
    error: '服务器内部错误',
    message: process.env.NODE_ENV !== 'production' ? err.message : undefined
  });
});

// ==================== 启动服务器 ====================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`
🚀 FootballDream API 服务器启动成功
├─ 环境: ${process.env.NODE_ENV || 'development'}
├─ 端口: ${PORT}
├─ 数据库: ${process.env.DATABASE_URL ? 'Neon PostgreSQL ✅' : '未配置 ❌'}
├─ 时间: ${new Date().toISOString()}

📡 核心端点:
├─ 健康检查: GET /
├─ 用户登录: POST /api/auth/login
├─ 用户注册: POST /api/auth/register
├─ 用户信息: GET /api/auth/me
├─ 历史记录: GET /api/history?userId={id}

🔧 开发工具:
├─ 数据库测试: GET /api/test-db
├─ 开发模式历史记录: GET /api/dev/history

⚠️  注意: 确保已正确配置环境变量
  `);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('收到关闭信号，释放数据库连接池...');
  if (pool) pool.end();
  process.exit(0);
});

module.exports = app;
