// ============ 导入依赖 ============
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');

// ============ 初始化应用 ============
const app = express();
const port = process.env.PORT || 3000;

// ============ 数据库连接 ============
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,  // 对于Neon需要这个
    require: true
  }
});

// 测试数据库连接
pool.connect()
  .then(() => console.log('✅ PostgreSQL数据库连接成功'))
  .catch(err => console.error('❌ 数据库连接失败:', err));

// ============ 初始化数据库表 ============
const initDatabase = async () => {
  try {
    console.log('正在初始化数据库表...');
    
    // 用户表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100),
        password VARCHAR(255) NOT NULL,
        user_type VARCHAR(20) DEFAULT 'trial',
        trial_count INTEGER DEFAULT 0,
        max_trial_count INTEGER DEFAULT 18,
        trial_end_date TIMESTAMP,
        registration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT TRUE,
        reset_password_token VARCHAR(255),
        reset_password_expires TIMESTAMP,
        invited_by VARCHAR(50),
        invite_code_used VARCHAR(50),
        subscription_type VARCHAR(20),
        subscription_start_date TIMESTAMP,
        subscription_end_date TIMESTAMP,
        subscription_active BOOLEAN DEFAULT FALSE,
        settings JSONB DEFAULT '{"theme":"auto","notifications":true,"language":"zh-CN"}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 邀请码表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS invitation_codes (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        created_by VARCHAR(50) NOT NULL,
        created_for VARCHAR(50),
        max_uses INTEGER DEFAULT 1,
        used_count INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        expires_at TIMESTAMP,
        used_by JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 记录表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS records (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        match_name VARCHAR(200) NOT NULL,
        handicap_type VARCHAR(10) NOT NULL,
        initial_handicap NUMERIC(5,2) NOT NULL,
        current_handicap NUMERIC(5,2) NOT NULL,
        initial_water NUMERIC(4,2) NOT NULL,
        current_water NUMERIC(4,2) NOT NULL,
        handicap_change NUMERIC(5,2) NOT NULL,
        water_change NUMERIC(4,2) NOT NULL,
        historical_record VARCHAR(10) NOT NULL,
        recommendation VARCHAR(50) NOT NULL,
        actual_result VARCHAR(10),
        analysis JSONB DEFAULT '{"probability":0,"confidence":0,"factors":[]}',
        is_synced BOOLEAN DEFAULT TRUE,
        device_id VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 统计表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS statistics (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        month VARCHAR(7) NOT NULL,
        total_records INTEGER DEFAULT 0,
        win_rate NUMERIC(5,2) DEFAULT 0,
        asian_win_rate NUMERIC(5,2) DEFAULT 0,
        size_win_rate NUMERIC(5,2) DEFAULT 0,
        water_up_win_rate NUMERIC(5,2) DEFAULT 0,
        water_down_win_rate NUMERIC(5,2) DEFAULT 0,
        handicap_up_win_rate NUMERIC(5,2) DEFAULT 0,
        handicap_down_win_rate NUMERIC(5,2) DEFAULT 0,
        low_water_win_rate NUMERIC(5,2) DEFAULT 0,
        top_matches JSONB DEFAULT '[]',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, month)
      )
    `);
    
    // 创建索引
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_user_type ON users(user_type);
      CREATE INDEX IF NOT EXISTS idx_records_user_id ON records(user_id);
      CREATE INDEX IF NOT EXISTS idx_records_created_at ON records(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_invitation_codes_code ON invitation_codes(code);
      CREATE INDEX IF NOT EXISTS idx_invitation_codes_is_active ON invitation_codes(is_active);
    `);
    
    // 创建默认管理员账户
    const adminCheck = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [process.env.ADMIN_USERNAME || 'admin']
    );
    
    if (adminCheck.rows.length === 0) {
      const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 12);
      await pool.query(
        `INSERT INTO users (username, password, user_type, email, is_active) 
         VALUES ($1, $2, $3, $4, $5)`,
        [
          process.env.ADMIN_USERNAME || 'admin',
          hashedPassword,
          'admin',
          'admin@footballbetting.com',
          true
        ]
      );
      console.log('✅ 默认管理员账户已创建');
    }
    
    // 创建一些测试邀请码
    const testCodes = ['TEST123', 'TEST456', 'INVITE789'];
    for (const code of testCodes) {
      const codeCheck = await pool.query(
        'SELECT id FROM invitation_codes WHERE code = $1',
        [code]
      );
      
      if (codeCheck.rows.length === 0) {
        await pool.query(
          `INSERT INTO invitation_codes (code, created_by, is_active, expires_at) 
           VALUES ($1, $2, $3, $4)`,
          [code, 'system', true, new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)]
        );
      }
    }
    
    console.log('✅ 数据库初始化完成');
  } catch (error) {
    console.error('❌ 数据库初始化失败:', error);
  }
};

// ============ 中间件 ============
app.use(helmet());
app.use(cors({
  origin: function(origin, callback) {
    // 允许所有来源或指定来源
    const allowedOrigins = [
      'http://localhost:8080',
      'http://127.0.0.1:8080',
      'https://your-frontend.vercel.app',
      'https://backenbsfootball.vercel.app'
    ];
    
    if (!origin || allowedOrigins.includes(origin) || origin.includes('localhost') || origin.includes('127.0.0.1')) {
      callback(null, true);
    } else {
      callback(new Error('不允许的跨域请求'));
    }
  },
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 日志中间件
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// ============ 认证中间件 ============
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ success: false, error: '未提供认证令牌' });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-super-secret-jwt-key');
    req.userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(403).json({ success: false, error: '无效的认证令牌' });
  }
};

const authenticateAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ success: false, error: '未提供认证令牌' });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-super-secret-jwt-key');
    req.userId = decoded.userId;
    
    // 检查是否为管理员
    const userResult = await pool.query(
      'SELECT user_type FROM users WHERE id = $1',
      [req.userId]
    );
    
    if (userResult.rows.length === 0 || userResult.rows[0].user_type !== 'admin') {
      return res.status(403).json({ success: false, error: '需要管理员权限' });
    }
    
    next();
  } catch (error) {
    return res.status(403).json({ success: false, error: '无效的认证令牌' });
  }
};

// ============ 工具函数 ============
const generateToken = (userId) => {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET || 'your-super-secret-jwt-key',
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

const validateRegister = (req, res, next) => {
  const { username, password, invitationCode } = req.body;
  
  if (!username || username.length < 3) {
    return res.status(400).json({ success: false, error: '用户名至少需要3个字符' });
  }
  
  if (!password || password.length < 6) {
    return res.status(400).json({ success: false, error: '密码至少需要6个字符' });
  }
  
  if (!invitationCode) {
    return res.status(400).json({ success: false, error: '请提供邀请码' });
  }
  
  next();
};

// ============ API路由 ============

// 1. 健康检查
app.get('/', (req, res) => {
  res.json({ 
    success: true, 
    message: '足球盘口系统API正在运行',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/test', (req, res) => {
  res.json({ 
    success: true, 
    message: 'API测试端点正常工作',
    timestamp: new Date().toISOString()
  });
});

// 2. 用户注册
app.post('/api/register', validateRegister, async (req, res) => {
  try {
    const { username, password, invitationCode } = req.body;
    
    // 检查用户名是否已存在
    const userExists = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );
    
    if (userExists.rows.length > 0) {
      return res.status(400).json({ 
        success: false, 
        error: '用户名已存在' 
      });
    }
    
    // 验证邀请码
    const codeResult = await pool.query(
      'SELECT * FROM invitation_codes WHERE code = $1',
      [invitationCode]
    );
    
    if (codeResult.rows.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: '邀请码无效' 
      });
    }
    
    const code = codeResult.rows[0];
    
    if (!code.is_active) {
      return res.status(400).json({ 
        success: false, 
        error: '邀请码已失效' 
      });
    }
    
    if (code.expires_at && new Date() > code.expires_at) {
      return res.status(400).json({ 
        success: false, 
        error: '邀请码已过期' 
      });
    }
    
    if (code.used_count >= code.max_uses) {
      return res.status(400).json({ 
        success: false, 
        error: '邀请码使用次数已达上限' 
      });
    }
    
    // 加密密码
    const hashedPassword = await bcrypt.hash(password, 12);
    
    // 创建用户
    const userResult = await pool.query(
      `INSERT INTO users 
       (username, password, user_type, invite_code_used, invited_by) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, username, user_type, registration_date`,
      [username, hashedPassword, 'registered', invitationCode, code.created_by]
    );
    
    // 更新邀请码使用记录
    const usedBy = code.used_by || [];
    usedBy.push({
      username: username,
      used_at: new Date().toISOString(),
      user_id: userResult.rows[0].id
    });
    
    await pool.query(
      `UPDATE invitation_codes 
       SET used_count = used_count + 1, 
           used_by = $1,
           is_active = CASE WHEN used_count + 1 >= max_uses THEN false ELSE is_active END
       WHERE code = $2`,
      [usedBy, invitationCode]
    );
    
    // 生成JWT令牌
    const token = generateToken(userResult.rows[0].id);
    
    res.status(201).json({
      success: true,
      user: {
        id: userResult.rows[0].id,
        username: userResult.rows[0].username,
        userType: userResult.rows[0].user_type,
        registrationDate: userResult.rows[0].registration_date
      },
      token,
      message: '注册成功'
    });
    
  } catch (error) {
    console.error('注册错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '服务器内部错误' 
    });
  }
});

// 3. 用户登录
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ 
        success: false, 
        error: '用户名和密码不能为空' 
      });
    }
    
    // 查找用户（包括密码字段）
    const userResult = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(401).json({ 
        success: false, 
        error: '用户名或密码错误' 
      });
    }
    
    const user = userResult.rows[0];
    
    // 验证密码
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ 
        success: false, 
        error: '用户名或密码错误' 
      });
    }
    
    // 检查用户是否激活
    if (!user.is_active) {
      return res.status(403).json({ 
        success: false, 
        error: '账户已被禁用' 
      });
    }
    
    // 更新最后登录时间
    await pool.query(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );
    
    // 生成JWT令牌
    const token = generateToken(user.id);
    
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        userType: user.user_type,
        trialCount: user.trial_count,
        maxTrialCount: user.max_trial_count,
        trialEndDate: user.trial_end_date,
        subscription: {
          type: user.subscription_type,
          isActive: user.subscription_active
        }
      },
      token,
      message: '登录成功'
    });
    
  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '服务器内部错误' 
    });
  }
});

// 4. 获取邀请码列表
app.get('/api/invitation-codes', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT code, created_by, created_at, 
              is_active, used_count, max_uses, 
              expires_at, used_by
       FROM invitation_codes 
       WHERE is_active = true 
       ORDER BY created_at DESC`
    );
    
    res.json({
      success: true,
      codes: result.rows.map(row => ({
        code: row.code,
        created_by: row.created_by,
        created_at: row.created_at,
        is_active: row.is_active,
        used_count: row.used_count,
        max_uses: row.max_uses,
        expires_at: row.expires_at,
        used_by: row.used_by || []
      }))
    });
    
  } catch (error) {
    console.error('获取邀请码错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '服务器内部错误' 
    });
  }
});

// 5. 导入邀请码（需要管理员权限）
app.post('/api/invitation-codes', authenticateAdmin, async (req, res) => {
  try {
    const { codes, createdBy = 'admin' } = req.body;
    
    if (!Array.isArray(codes) || codes.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: '请提供有效的邀请码数组' 
      });
    }
    
    const inserted = [];
    const errors = [];
    
    for (const code of codes) {
      try {
        // 检查是否已存在
        const existing = await pool.query(
          'SELECT id FROM invitation_codes WHERE code = $1',
          [code]
        );
        
        if (existing.rows.length === 0) {
          await pool.query(
            `INSERT INTO invitation_codes (code, created_by, is_active) 
             VALUES ($1, $2, $3)`,
            [code, createdBy, true]
          );
          inserted.push(code);
        } else {
          errors.push(`${code}: 已存在`);
        }
      } catch (error) {
        errors.push(`${code}: ${error.message}`);
      }
    }
    
    res.json({
      success: true,
      inserted,
      errors,
      message: `成功导入 ${inserted.length} 个邀请码`
    });
    
  } catch (error) {
    console.error('导入邀请码错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '服务器内部错误' 
    });
  }
});

// 6. 获取用户历史记录
app.get('/api/history', authenticateToken, async (req, res) => {
  try {
    const { userId } = req;
    
    const result = await pool.query(
      `SELECT r.*, u.username 
       FROM records r 
       LEFT JOIN users u ON r.user_id = u.id 
       WHERE r.user_id = $1 
       ORDER BY r.created_at DESC`,
      [userId]
    );
    
    res.json({
      success: true,
      records: result.rows.map(record => ({
        id: record.id,
        match_name: record.match_name,
        handicap_type: record.handicap_type,
        initial_handicap: parseFloat(record.initial_handicap),
        current_handicap: parseFloat(record.current_handicap),
        initial_water: parseFloat(record.initial_water),
        current_water: parseFloat(record.current_water),
        handicap_change: parseFloat(record.handicap_change),
        water_change: parseFloat(record.water_change),
        historical_record: record.historical_record,
        recommendation: record.recommendation,
        actual_result: record.actual_result,
        created_at: record.created_at,
        username: record.username
      }))
    });
    
  } catch (error) {
    console.error('获取历史记录错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '服务器内部错误' 
    });
  }
});

// 7. 保存记录
app.post('/api/records', authenticateToken, async (req, res) => {
  try {
    const { userId } = req;
    const record = req.body;
    
    // 检查用户是否可以保存记录
    const userResult = await pool.query(
      'SELECT user_type, trial_count, max_trial_count FROM users WHERE id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: '用户不存在' 
      });
    }
    
    const user = userResult.rows[0];
    
    // 试用用户检查次数限制
    if (user.user_type === 'trial' && user.trial_count >= user.max_trial_count) {
      return res.status(403).json({ 
        success: false, 
        error: '试用次数已用完，请注册成为正式会员' 
      });
    }
    
    // 插入记录
    const result = await pool.query(
      `INSERT INTO records 
       (user_id, match_name, handicap_type, initial_handicap, current_handicap, 
        initial_water, current_water, handicap_change, water_change, 
        historical_record, recommendation, actual_result) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
       RETURNING id, created_at`,
      [
        userId,
        record.match_name,
        record.handicap_type,
        record.initial_handicap,
        record.current_handicap,
        record.initial_water,
        record.current_water,
        record.handicap_change,
        record.water_change,
        record.historical_record,
        record.recommendation,
        record.actual_result || ''
      ]
    );
    
    // 更新试用次数
    if (user.user_type === 'trial') {
      await pool.query(
        'UPDATE users SET trial_count = trial_count + 1 WHERE id = $1',
        [userId]
      );
    }
    
    res.status(201).json({
      success: true,
      recordId: result.rows[0].id,
      created_at: result.rows[0].created_at,
      remainingTrial: user.user_type === 'trial' ? 
        Math.max(0, user.max_trial_count - user.trial_count - 1) : null,
      message: '记录保存成功'
    });
    
  } catch (error) {
    console.error('保存记录错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '服务器内部错误' 
    });
  }
});

// 8. 更新记录（实际结果）
app.put('/api/records/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req;
    const { actual_result } = req.body;
    
    // 检查记录是否存在且属于该用户
    const recordCheck = await pool.query(
      'SELECT user_id FROM records WHERE id = $1',
      [id]
    );
    
    if (recordCheck.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: '记录不存在' 
      });
    }
    
    if (recordCheck.rows[0].user_id !== userId) {
      return res.status(403).json({ 
        success: false, 
        error: '无权修改此记录' 
      });
    }
    
    // 更新记录
    await pool.query(
      'UPDATE records SET actual_result = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [actual_result, id]
    );
    
    res.json({
      success: true,
      message: '记录更新成功'
    });
    
  } catch (error) {
    console.error('更新记录错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '服务器内部错误' 
    });
  }
});

// 9. 删除记录
app.delete('/api/records/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req;
    
    // 检查记录是否存在且属于该用户
    const recordCheck = await pool.query(
      'SELECT user_id FROM records WHERE id = $1',
      [id]
    );
    
    if (recordCheck.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: '记录不存在' 
      });
    }
    
    if (recordCheck.rows[0].user_id !== userId) {
      return res.status(403).json({ 
        success: false, 
        error: '无权删除此记录' 
      });
    }
    
    // 删除记录
    await pool.query('DELETE FROM records WHERE id = $1', [id]);
    
    res.json({
      success: true,
      message: '记录删除成功'
    });
    
  } catch (error) {
    console.error('删除记录错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '服务器内部错误' 
    });
  }
});

// 10. 让球盘推荐
app.post('/api/recommend/asian', async (req, res) => {
  try {
    const data = req.body;
    
    // 简单的推荐算法示例
    const { 
      initialHandicap, 
      currentHandicap, 
      initialWater, 
      currentWater, 
      historicalRecord 
    } = data;
    
    let recommendation = '上盘';
    let details = '';
    
    // 简单的逻辑判断
    const handicapChange = currentHandicap - initialHandicap;
    const waterChange = currentWater - initialWater;
    
    if (handicapChange > 0 && waterChange > 0) {
      recommendation = '上盘';
      details = '盘口和水位同时上升，看好上盘';
    } else if (handicapChange < 0 && waterChange < 0) {
      recommendation = '下盘';
      details = '盘口和水位同时下降，看好下盘';
    } else if (currentWater < 0.85) {
      recommendation = '上盘';
      details = '低水位支撑上盘';
    } else if (historicalRecord === 'win') {
      recommendation = '上盘';
      details = '历史战绩支持上盘';
    } else {
      recommendation = '下盘';
      details = '综合考虑推荐下盘';
    }
    
    res.json({
      success: true,
      recommendation,
      details,
      analysis: {
        handicapChange,
        waterChange,
        confidence: 75,
        factors: ['盘口变化', '水位变化', '历史战绩']
      }
    });
    
  } catch (error) {
    console.error('推荐计算错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '推荐计算失败' 
    });
  }
});

// 11. 大小盘推荐
app.post('/api/recommend/size', async (req, res) => {
  try {
    const data = req.body;
    
    // 简单的推荐算法示例
    const { 
      initialHandicap, 
      currentHandicap, 
      initialWater, 
      currentWater, 
      historicalRecord 
    } = data;
    
    let recommendation = '大球';
    let details = '';
    
    // 简单的逻辑判断
    const handicapChange = currentHandicap - initialHandicap;
    const waterChange = currentWater - initialWater;
    
    if (handicapChange > 0 && waterChange > 0) {
      recommendation = '大球';
      details = '盘口和水位同时上升，看好大球';
    } else if (handicapChange < 0 && waterChange < 0) {
      recommendation = '小球';
      details = '盘口和水位同时下降，看好小球';
    } else if (currentHandicap > 2.5) {
      recommendation = '大球';
      details = '高盘口支撑大球';
    } else if (historicalRecord === 'win') {
      recommendation = '大球';
      details = '历史战绩支持大球';
    } else {
      recommendation = '小球';
      details = '综合考虑推荐小球';
    }
    
    res.json({
      success: true,
      recommendation,
      details,
      analysis: {
        handicapChange,
        waterChange,
        confidence: 70,
        factors: ['盘口变化', '水位变化', '历史战绩']
      }
    });
    
  } catch (error) {
    console.error('推荐计算错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '推荐计算失败' 
    });
  }
});

// 12. 获取统计信息
app.get('/api/stats', authenticateToken, async (req, res) => {
  try {
    const { userId } = req;
    
    // 获取总记录数
    const totalResult = await pool.query(
      'SELECT COUNT(*) as count FROM records WHERE user_id = $1',
      [userId]
    );
    
    // 获取胜率统计
    const winRateResult = await pool.query(
      `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN actual_result = 'win' THEN 1 ELSE 0 END) as wins
       FROM records 
       WHERE user_id = $1 AND actual_result IS NOT NULL`,
      [userId]
    );
    
    // 获取不同类型胜率
    const typeResult = await pool.query(
      `SELECT 
        handicap_type,
        COUNT(*) as total,
        SUM(CASE WHEN actual_result = 'win' THEN 1 ELSE 0 END) as wins
       FROM records 
       WHERE user_id = $1 AND actual_result IS NOT NULL
       GROUP BY handicap_type`,
      [userId]
    );
    
    // 获取变化胜率
    const changeResult = await pool.query(
      `SELECT 
        SUM(CASE WHEN water_change > 0 AND actual_result = 'win' THEN 1 ELSE 0 END) as water_up_wins,
        SUM(CASE WHEN water_change > 0 THEN 1 ELSE 0 END) as water_up_total,
        SUM(CASE WHEN water_change < 0 AND actual_result = 'win' THEN 1 ELSE 0 END) as water_down_wins,
        SUM(CASE WHEN water_change < 0 THEN 1 ELSE 0 END) as water_down_total,
        SUM(CASE WHEN handicap_change > 0 AND actual_result = 'win' THEN 1 ELSE 0 END) as handicap_up_wins,
        SUM(CASE WHEN handicap_change > 0 THEN 1 ELSE 0 END) as handicap_up_total,
        SUM(CASE WHEN handicap_change < 0 AND actual_result = 'win' THEN 1 ELSE 0 END) as handicap_down_wins,
        SUM(CASE WHEN handicap_change < 0 THEN 1 ELSE 0 END) as handicap_down_total,
        SUM(CASE WHEN current_water < 0.90 AND actual_result = 'win' THEN 1 ELSE 0 END) as low_water_wins,
        SUM(CASE WHEN current_water < 0.90 THEN 1 ELSE 0 END) as low_water_total
       FROM records 
       WHERE user_id = $1 AND actual_result IS NOT NULL`,
      [userId]
    );
    
    const total = parseInt(totalResult.rows[0].count);
    const winRate = winRateResult.rows[0].total > 0 ? 
      Math.round((winRateResult.rows[0].wins / winRateResult.rows[0].total) * 100) : 0;
    
    const typeStats = {};
    typeResult.rows.forEach(row => {
      typeStats[row.handicap_type] = row.total > 0 ? 
        Math.round((row.wins / row.total) * 100) : 0;
    });
    
    const changeData = changeResult.rows[0];
    
    res.json({
      success: true,
      stats: {
        totalRecords: total,
        winRate: winRate,
        asianWinRate: typeStats.asian || 0,
        sizeWinRate: typeStats.size || 0,
        waterUpWinRate: changeData.water_up_total > 0 ? 
          Math.round((changeData.water_up_wins / changeData.water_up_total) * 100) : 0,
        waterDownWinRate: changeData.water_down_total > 0 ? 
          Math.round((changeData.water_down_wins / changeData.water_down_total) * 100) : 0,
        handicapUpWinRate: changeData.handicap_up_total > 0 ? 
          Math.round((changeData.handicap_up_wins / changeData.handicap_up_total) * 100) : 0,
        handicapDownWinRate: changeData.handicap_down_total > 0 ? 
          Math.round((changeData.handicap_down_wins / changeData.handicap_down_total) * 100) : 0,
        lowWaterWinRate: changeData.low_water_total > 0 ? 
          Math.round((changeData.low_water_wins / changeData.low_water_total) * 100) : 0
      }
    });
    
  } catch (error) {
    console.error('获取统计信息错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '服务器内部错误' 
    });
  }
});

// 13. 用户信息
app.get('/api/user/info', authenticateToken, async (req, res) => {
  try {
    const { userId } = req;
    
    const userResult = await pool.query(
      `SELECT id, username, user_type, trial_count, max_trial_count, 
              trial_end_date, registration_date, last_login,
              subscription_type, subscription_active, subscription_end_date,
              settings
       FROM users WHERE id = $1`,
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: '用户不存在' 
      });
    }
    
    const user = userResult.rows[0];
    
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        userType: user.user_type,
        trialCount: user.trial_count,
        maxTrialCount: user.max_trial_count,
        remainingTrialCount: Math.max(0, user.max_trial_count - user.trial_count),
        trialEndDate: user.trial_end_date,
        registrationDate: user.registration_date,
        lastLogin: user.last_login,
        subscription: {
          type: user.subscription_type,
          isActive: user.subscription_active,
          endDate: user.subscription_end_date
        },
        settings: user.settings
      }
    });
    
  } catch (error) {
    console.error('获取用户信息错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '服务器内部错误' 
    });
  }
});

// 14. 同步本地数据
app.post('/api/sync', authenticateToken, async (req, res) => {
  try {
    const { userId } = req;
    const { records = [] } = req.body;
    
    const synced = [];
    const errors = [];
    
    for (const record of records) {
      try {
        // 检查是否已存在（通过设备ID或时间戳）
        const existing = await pool.query(
          'SELECT id FROM records WHERE user_id = $1 AND device_id = $2',
          [userId, record.deviceId]
        );
        
        if (existing.rows.length === 0) {
          // 插入新记录
          const result = await pool.query(
            `INSERT INTO records 
             (user_id, match_name, handicap_type, initial_handicap, current_handicap, 
              initial_water, current_water, handicap_change, water_change, 
              historical_record, recommendation, actual_result, device_id, is_synced) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true) 
             RETURNING id`,
            [
              userId,
              record.match_name,
              record.handicap_type,
              record.initial_handicap,
              record.current_handicap,
              record.initial_water,
              record.current_water,
              record.handicap_change,
              record.water_change,
              record.historical_record,
              record.recommendation,
              record.actual_result || '',
              record.deviceId || 'local'
            ]
          );
          
          synced.push({ id: result.rows[0].id, deviceId: record.deviceId });
        } else {
          // 更新现有记录
          await pool.query(
            `UPDATE records SET 
              match_name = $1, handicap_type = $2, initial_handicap = $3, current_handicap = $4,
              initial_water = $5, current_water = $6, handicap_change = $7, water_change = $8,
              historical_record = $9, recommendation = $10, actual_result = $11, is_synced = true
             WHERE id = $12`,
            [
              record.match_name,
              record.handicap_type,
              record.initial_handicap,
              record.current_handicap,
              record.initial_water,
              record.current_water,
              record.handicap_change,
              record.water_change,
              record.historical_record,
              record.recommendation,
              record.actual_result || '',
              existing.rows[0].id
            ]
          );
          
          synced.push({ id: existing.rows[0].id, deviceId: record.deviceId });
        }
      } catch (error) {
        errors.push({ deviceId: record.deviceId, error: error.message });
      }
    }
    
    res.json({
      success: true,
      synced,
      errors,
      message: `成功同步 ${synced.length} 条记录`
    });
    
  } catch (error) {
    console.error('同步数据错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '服务器内部错误' 
    });
  }
});

// ============ 错误处理 ============
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: '未找到请求的资源'
  });
});

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({
    success: false,
    error: '服务器内部错误'
  });
});

// ============ 启动服务器 ============
const startServer = async () => {
  try {
    // 初始化数据库
    await initDatabase();
    
    // 启动服务器
    app.listen(port, () => {
      console.log(`🚀 服务器运行在 http://localhost:${port}`);
      console.log(`📊 健康检查: http://localhost:${port}/`);
      console.log(`🔧 测试端点: http://localhost:${port}/api/test`);
    });
  } catch (error) {
    console.error('❌ 服务器启动失败:', error);
    process.exit(1);
  }
};

// 启动应用
startServer();
