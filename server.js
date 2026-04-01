// =====================================================
// HABESHA CASINO - BACKEND SERVER
// Run: node server.js
// =====================================================

const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// =====================================================
// CONFIGURATION
// =====================================================
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// =====================================================
// DATABASE CONNECTION
// =====================================================
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'habesha_casino',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
});

// Test database connection
async function testConnection() {
    try {
        const connection = await pool.getConnection();
        console.log('✅ MySQL Connected successfully!');
        console.log(`📀 Database: ${process.env.DB_NAME || 'habesha_casino'}`);
        connection.release();
        return true;
    } catch (error) {
        console.error('❌ MySQL Connection failed:', error.message);
        console.log('💡 Please ensure MySQL is running and database exists');
        return false;
    }
}
testConnection();

// =====================================================
// ==================== AUTHENTICATION ====================
// =====================================================

// Register or Login user
app.post('/api/auth/login', async (req, res) => {
    const { name, phone, password } = req.body;
    
    if (!name || !phone || !password) {
        return res.status(400).json({ error: 'All fields required' });
    }
    
    try {
        // Check if user exists
        const [users] = await pool.execute(
            'SELECT * FROM users WHERE phone = ?',
            [phone]
        );
        
        if (users.length > 0) {
            const user = users[0];
            
            // Verify password
            if (password !== user.password) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }
            
            if (user.blocked) {
                return res.status(403).json({ error: 'Account blocked. Contact support.' });
            }
            
            // Update last login
            await pool.execute(
                'UPDATE users SET last_login = NOW() WHERE phone = ?',
                [phone]
            );
            
            // Get user streak
            const [streaks] = await pool.execute(
                'SELECT * FROM user_streaks WHERE user_phone = ?',
                [phone]
            );
            
            res.json({
                success: true,
                user: {
                    id: user.id,
                    name: user.name,
                    phone: user.phone,
                    balance: parseFloat(user.balance),
                    approved: user.approved === 1,
                    blocked: user.blocked === 1,
                    wins: user.wins,
                    losses: user.losses
                },
                streak: streaks[0] || { streak: 0, wins: 0, losses: 0 }
            });
        } else {
            // Register new user
            const [result] = await pool.execute(
                'INSERT INTO users (name, phone, password, approved) VALUES (?, ?, ?, ?)',
                [name, phone, password, false]
            );
            
            // Create initial streak record
            await pool.execute(
                'INSERT INTO user_streaks (user_phone, streak, wins, losses) VALUES (?, 0, 0, 0)',
                [phone]
            );
            
            res.json({
                success: true,
                user: {
                    id: result.insertId,
                    name: name,
                    phone: phone,
                    balance: 0,
                    approved: false,
                    blocked: false,
                    wins: 0,
                    losses: 0
                },
                streak: { streak: 0, wins: 0, losses: 0 },
                pending_approval: true
            });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// =====================================================
// ==================== USER MANAGEMENT ====================
// =====================================================

// Get all users (Admin)
app.get('/api/admin/users', async (req, res) => {
    try {
        const [users] = await pool.execute(
            `SELECT id, phone, name, balance, approved, blocked, wins, losses, 
                    total_deposited, total_withdrawn, created_at, last_login 
             FROM users ORDER BY created_at DESC`
        );
        res.json({ 
            success: true, 
            users: users.map(u => ({ ...u, balance: parseFloat(u.balance) }))
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get single user by phone
app.get('/api/users/:phone', async (req, res) => {
    const { phone } = req.params;
    try {
        const [users] = await pool.execute(
            'SELECT id, phone, name, balance, approved, blocked, wins, losses FROM users WHERE phone = ?',
            [phone]
        );
        if (users.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({ success: true, user: users[0] });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Approve user (Admin)
app.post('/api/admin/users/:phone/approve', async (req, res) => {
    const { phone } = req.params;
    
    try {
        await pool.execute(
            'UPDATE users SET approved = TRUE WHERE phone = ?',
            [phone]
        );
        
        // Log admin action
        await pool.execute(
            'INSERT INTO admin_logs (admin_name, action, target_user) VALUES (?, ?, ?)',
            ['admin', 'approve_user', phone]
        );
        
        res.json({ success: true, message: 'User approved' });
    } catch (error) {
        console.error('Error approving user:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Block/Unblock user (Admin)
app.post('/api/admin/users/:phone/block', async (req, res) => {
    const { phone } = req.params;
    const { blocked } = req.body;
    
    try {
        await pool.execute(
            'UPDATE users SET blocked = ? WHERE phone = ?',
            [blocked ? 1 : 0, phone]
        );
        
        await pool.execute(
            'INSERT INTO admin_logs (admin_name, action, target_user, details) VALUES (?, ?, ?, ?)',
            ['admin', blocked ? 'block_user' : 'unblock_user', phone, `Blocked: ${blocked}`]
        );
        
        res.json({ success: true, message: blocked ? 'User blocked' : 'User unblocked' });
    } catch (error) {
        console.error('Error blocking user:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Add funds to user (Admin)
app.post('/api/admin/users/:phone/add-funds', async (req, res) => {
    const { phone } = req.params;
    const { amount } = req.body;
    
    if (!amount || amount <= 0) {
        return res.status(400).json({ error: 'Invalid amount' });
    }
    
    try {
        await pool.execute(
            'UPDATE users SET balance = balance + ?, total_deposited = total_deposited + ? WHERE phone = ?',
            [amount, amount, phone]
        );
        
        await pool.execute(
            'INSERT INTO admin_logs (admin_name, action, target_user, details) VALUES (?, ?, ?, ?)',
            ['admin', 'add_funds', phone, `Added ${amount} Birr`]
        );
        
        res.json({ success: true, message: `Added ${amount} Birr to user` });
    } catch (error) {
        console.error('Error adding funds:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// =====================================================
// ==================== DEPOSIT & WITHDRAWAL ====================
// =====================================================

// Create deposit request
app.post('/api/deposit', async (req, res) => {
    const { phone, name, amount, transactionId } = req.body;
    
    if (!amount || amount < 50) {
        return res.status(400).json({ error: 'Minimum deposit is 50 Birr' });
    }
    
    try {
        await pool.execute(
            `INSERT INTO deposit_requests (user_phone, user_name, amount, transaction_id) 
             VALUES (?, ?, ?, ?)`,
            [phone, name, amount, transactionId]
        );
        
        res.json({ success: true, message: 'Deposit request submitted' });
    } catch (error) {
        console.error('Deposit error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Create withdrawal request
app.post('/api/withdraw', async (req, res) => {
    const { phone, name, amount, phoneNumber } = req.body;
    
    if (!amount || amount < 200) {
        return res.status(400).json({ error: 'Minimum withdrawal is 200 Birr' });
    }
    
    try {
        // Check user balance
        const [users] = await pool.execute(
            'SELECT balance FROM users WHERE phone = ?',
            [phone]
        );
        
        if (users.length === 0 || users[0].balance < amount) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        await pool.execute(
            `INSERT INTO withdrawal_requests (user_phone, user_name, amount, phone_number) 
             VALUES (?, ?, ?, ?)`,
            [phone, name, amount, phoneNumber]
        );
        
        res.json({ success: true, message: 'Withdrawal request submitted' });
    } catch (error) {
        console.error('Withdrawal error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get pending withdrawals (Admin)
app.get('/api/admin/withdrawals', async (req, res) => {
    try {
        const [withdrawals] = await pool.execute(
            'SELECT * FROM withdrawal_requests WHERE status = "pending" ORDER BY created_at DESC'
        );
        res.json({ success: true, withdrawals });
    } catch (error) {
        console.error('Error fetching withdrawals:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Approve withdrawal (Admin)
app.post('/api/admin/withdrawals/:id/approve', async (req, res) => {
    const { id } = req.params;
    
    try {
        // Get withdrawal details
        const [withdrawals] = await pool.execute(
            'SELECT * FROM withdrawal_requests WHERE id = ?',
            [id]
        );
        
        if (withdrawals.length === 0) {
            return res.status(404).json({ error: 'Withdrawal not found' });
        }
        
        const withdrawal = withdrawals[0];
        
        // Deduct from user balance
        await pool.execute(
            'UPDATE users SET balance = balance - ?, total_withdrawn = total_withdrawn + ? WHERE phone = ?',
            [withdrawal.amount, withdrawal.amount, withdrawal.user_phone]
        );
        
        // Update withdrawal status
        await pool.execute(
            'UPDATE withdrawal_requests SET status = "approved", processed_at = NOW() WHERE id = ?',
            [id]
        );
        
        // Log admin action
        await pool.execute(
            'INSERT INTO admin_logs (admin_name, action, target_user, details) VALUES (?, ?, ?, ?)',
            ['admin', 'approve_withdrawal', withdrawal.user_phone, `Approved ${withdrawal.amount} Birr`]
        );
        
        res.json({ success: true, message: 'Withdrawal approved' });
    } catch (error) {
        console.error('Error approving withdrawal:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get pending deposits (Admin)
app.get('/api/admin/deposits', async (req, res) => {
    try {
        const [deposits] = await pool.execute(
            'SELECT * FROM deposit_requests WHERE status = "pending" ORDER BY created_at DESC'
        );
        res.json({ success: true, deposits });
    } catch (error) {
        console.error('Error fetching deposits:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Approve deposit (Admin)
app.post('/api/admin/deposits/:id/approve', async (req, res) => {
    const { id } = req.params;
    
    try {
        const [deposits] = await pool.execute(
            'SELECT * FROM deposit_requests WHERE id = ?',
            [id]
        );
        
        if (deposits.length === 0) {
            return res.status(404).json({ error: 'Deposit not found' });
        }
        
        const deposit = deposits[0];
        
        // Add to user balance
        await pool.execute(
            'UPDATE users SET balance = balance + ?, total_deposited = total_deposited + ? WHERE phone = ?',
            [deposit.amount, deposit.amount, deposit.user_phone]
        );
        
        // Update deposit status
        await pool.execute(
            'UPDATE deposit_requests SET status = "approved", processed_at = NOW() WHERE id = ?',
            [id]
        );
        
        // Log admin action
        await pool.execute(
            'INSERT INTO admin_logs (admin_name, action, target_user, details) VALUES (?, ?, ?, ?)',
            ['admin', 'approve_deposit', deposit.user_phone, `Approved ${deposit.amount} Birr`]
        );
        
        res.json({ success: true, message: 'Deposit approved' });
    } catch (error) {
        console.error('Error approving deposit:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// =====================================================
// ==================== GAME FUNCTIONS ====================
// =====================================================

// Update user balance after game
app.post('/api/game/update-balance', async (req, res) => {
    const { phone, balance, wins, losses } = req.body;
    
    try {
        await pool.execute(
            'UPDATE users SET balance = ?, wins = ?, losses = ? WHERE phone = ?',
            [balance, wins, losses, phone]
        );
        
        // Update streak
        await pool.execute(
            `INSERT INTO user_streaks (user_phone, wins, losses) 
             VALUES (?, ?, ?) 
             ON DUPLICATE KEY UPDATE 
             wins = wins + VALUES(wins), 
             losses = losses + VALUES(losses)`,
            [phone, wins || 0, losses || 0]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating balance:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Save game history
app.post('/api/game/history', async (req, res) => {
    const { userPhone, winnerName, prizeAmount, entryAmount, totalPlayers, gameNumber } = req.body;
    
    try {
        await pool.execute(
            `INSERT INTO game_history (user_phone, winner_name, prize_amount, entry_amount, total_players, game_number) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [userPhone, winnerName, prizeAmount, entryAmount, totalPlayers, gameNumber]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error saving game history:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get game history
app.get('/api/game/history', async (req, res) => {
    const { limit = 20 } = req.query;
    
    try {
        const [history] = await pool.execute(
            'SELECT * FROM game_history ORDER BY created_at DESC LIMIT ?',
            [parseInt(limit)]
        );
        res.json({ success: true, history });
    } catch (error) {
        console.error('Error fetching history:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update user streak
app.post('/api/game/streak', async (req, res) => {
    const { phone, streak, wins, losses } = req.body;
    
    try {
        await pool.execute(
            `INSERT INTO user_streaks (user_phone, streak, wins, losses) 
             VALUES (?, ?, ?, ?) 
             ON DUPLICATE KEY UPDATE 
             streak = VALUES(streak), 
             wins = VALUES(wins), 
             losses = VALUES(losses)`,
            [phone, streak, wins, losses]
        );
        
        // Update max streak
        await pool.execute(
            `UPDATE user_streaks 
             SET max_streak = GREATEST(max_streak, streak) 
             WHERE user_phone = ?`,
            [phone]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating streak:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// =====================================================
// ==================== STATISTICS ====================
// =====================================================

// Get dashboard stats (Admin)
app.get('/api/admin/stats', async (req, res) => {
    try {
        const [totalUsers] = await pool.execute('SELECT COUNT(*) as count FROM users');
        const [activeUsers] = await pool.execute('SELECT COUNT(*) as count FROM users WHERE approved = TRUE AND blocked = FALSE');
        const [blockedUsers] = await pool.execute('SELECT COUNT(*) as count FROM users WHERE blocked = TRUE');
        const [pendingUsers] = await pool.execute('SELECT COUNT(*) as count FROM users WHERE approved = FALSE');
        const [totalBalance] = await pool.execute('SELECT SUM(balance) as total FROM users');
        const [totalDeposits] = await pool.execute('SELECT SUM(amount) as total FROM deposit_requests WHERE status = "approved"');
        const [totalWithdrawals] = await pool.execute('SELECT SUM(amount) as total FROM withdrawal_requests WHERE status = "approved"');
        const [pendingWithdrawals] = await pool.execute('SELECT COUNT(*) as count FROM withdrawal_requests WHERE status = "pending"');
        const [todayGames] = await pool.execute('SELECT COUNT(*) as count FROM game_history WHERE DATE(created_at) = CURDATE()');
        const [todayUsers] = await pool.execute('SELECT COUNT(*) as count FROM users WHERE DATE(created_at) = CURDATE()');
        
        res.json({
            success: true,
            stats: {
                totalUsers: totalUsers[0].count,
                activeUsers: activeUsers[0].count,
                blockedUsers: blockedUsers[0].count,
                pendingUsers: pendingUsers[0].count,
                totalBalance: parseFloat(totalBalance[0].total || 0),
                totalDeposits: parseFloat(totalDeposits[0].total || 0),
                totalWithdrawals: parseFloat(totalWithdrawals[0].total || 0),
                pendingWithdrawals: pendingWithdrawals[0].count,
                todayGames: todayGames[0].count,
                todayUsers: todayUsers[0].count
            }
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// =====================================================
// ==================== SUPPORT ====================
// =====================================================

// Save support message
app.post('/api/support', async (req, res) => {
    const { name, phone, message } = req.body;
    
    if (!name || !phone || !message) {
        return res.status(400).json({ error: 'All fields required' });
    }
    
    try {
        await pool.execute(
            'INSERT INTO support_messages (name, phone, message) VALUES (?, ?, ?)',
            [name, phone, message]
        );
        res.json({ success: true, message: 'Support message sent' });
    } catch (error) {
        console.error('Error saving support message:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get support messages (Admin)
app.get('/api/admin/support', async (req, res) => {
    try {
        const [messages] = await pool.execute(
            'SELECT * FROM support_messages WHERE status = "pending" ORDER BY created_at DESC'
        );
        res.json({ success: true, messages });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Mark support message as resolved (Admin)
app.post('/api/admin/support/:id/resolve', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.execute(
            'UPDATE support_messages SET status = "resolved", resolved_at = NOW() WHERE id = ?',
            [id]
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// =====================================================
// ==================== HEALTH CHECK ====================
// =====================================================

app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ 
            status: 'healthy', 
            database: 'connected',
            timestamp: new Date().toISOString(),
            uptime: process.uptime()
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'unhealthy', 
            database: 'disconnected',
            error: error.message
        });
    }
});

// =====================================================
// ==================== FRONTEND ROUTE ====================
// =====================================================

// Serve frontend (for production)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =====================================================
// ==================== START SERVER ====================
// =====================================================

app.listen(PORT, () => {
    console.log('========================================');
    console.log('🚀 Habesha Casino Server Started');
    console.log('========================================');
    console.log(`📡 Server URL: http://localhost:${PORT}`);
    console.log(`📡 API URL: http://localhost:${PORT}/api`);
    console.log(`💾 Database: MySQL - ${process.env.DB_NAME || 'habesha_casino'}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log('========================================');
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down server...');
    await pool.end();
    process.exit(0);
});

module.exports = { app, pool };