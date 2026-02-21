export default {
    async fetch(request, env) {
        const { pathname, searchParams } = new URL(request.url);

        // 跨域头配置
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        // 严苛的 Cache-Control，杜绝一切中间缓存
        function jsonRes(data, status = 200) {
            return new Response(JSON.stringify(data), {
                status,
                headers: {
                    "Content-Type": "application/json",
                    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
                    ...corsHeaders
                },
            });
        }

        const checkD1 = () => !!env.battle_rooms;

        // D1 用户数据读写
        async function getUser(name) {
            const row = await env.battle_rooms.prepare(
                "SELECT data FROM users WHERE name = ?"
            ).bind(name).first();
            return row ? JSON.parse(row.data) : null;
        }

        async function putUser(name, data) {
            await env.battle_rooms.prepare(
                "INSERT OR REPLACE INTO users (name, data) VALUES (?, ?)"
            ).bind(name, JSON.stringify(data)).run();
        }

        try {
            // ==========================================
            // API 1：获取用户数据
            // ==========================================
            if (pathname === "/api/get-user") {
                if (!checkD1()) return jsonRes({ error: "服务器异常：未绑定 D1 数据库" }, 500);

                const name = searchParams.get("name");
                if (!name) return jsonRes({ error: "需要提供名称" }, 400);

                let data = await getUser(name);
                const today = new Date(Date.now() + 8 * 3600000).toDateString();

                if (!data) {
                    data = {
                        level: 1, exp: 0, coins: 0, pbs: {}, mistakes: [],
                        unlockedAvatars: ['🐻'], currentAvatar: '🐻',
                        unlockedThemes: ['default'], currentTheme: 'default',
                        streak: 1, lastLogin: today
                    };
                    await putUser(name, data);
                } else {
                    data.coins = data.coins || 0;
                    data.exp = parseInt(data.exp) || 0;
                    data.level = parseInt(data.level) || 1;
                    data.unlockedAvatars = data.unlockedAvatars || ['🐻'];
                    data.currentAvatar = data.currentAvatar || '🐻';
                    data.unlockedThemes = data.unlockedThemes || ['default'];
                    data.currentTheme = data.currentTheme || 'default';
                    data.mistakes = data.mistakes || [];
                    data.pbs = data.pbs || {};

                    if (data.lastLogin !== today) {
                        let yesterday = new Date(Date.now() + 8 * 3600000);
                        yesterday.setDate(yesterday.getDate() - 1);
                        if (data.lastLogin === yesterday.toDateString()) {
                            data.streak = (data.streak || 0) + 1;
                        } else {
                            data.streak = 1;
                        }
                        data.lastLogin = today;
                        await putUser(name, data);
                    }
                }
                return jsonRes(data);
            }

            // ==========================================
            // API 2：保存成绩并结算
            // ==========================================
            if (pathname === "/api/save-result" && request.method === "POST") {
                if (!checkD1()) return jsonRes({ error: "未绑定 D1 数据库" }, 500);
                const { name, result } = await request.json();

                let data = await getUser(name) || {
                    level: 1, exp: 0, coins: 0, pbs: {}, mistakes: [],
                    unlockedAvatars: ['🐻'], currentAvatar: '🐻',
                    unlockedThemes: ['default'], currentTheme: 'default'
                };

                data.exp = (parseInt(data.exp) || 0) + (parseInt(result.exp) || 0);
                data.coins = (parseInt(data.coins) || 0) + (parseInt(result.coinsGained) || 0);
                data.mistakes = data.mistakes || [];
                data.pbs = data.pbs || {};
                data.unlockedAvatars = data.unlockedAvatars || ['🐻'];

                let oldLevel = data.level || 1;
                data.level = Math.floor(Math.sqrt(data.exp / 30)) + 1;
                let leveledUp = data.level > oldLevel;

                let newUnlocks = [];
                if (data.level >= 5 && !data.unlockedAvatars.includes('🦊')) { data.unlockedAvatars.push('🦊'); newUnlocks.push('🦊'); }
                if (data.level >= 10 && !data.unlockedAvatars.includes('🦁')) { data.unlockedAvatars.push('🦁'); newUnlocks.push('🦁'); }
                if (data.level >= 15 && !data.unlockedAvatars.includes('🐉')) { data.unlockedAvatars.push('🐉'); newUnlocks.push('🐉'); }

                const pbKey = result.configKey;
                if (pbKey && pbKey !== 'room' && result.accuracy === 100 && (!data.pbs[pbKey] || result.time < data.pbs[pbKey])) {
                    data.pbs[pbKey] = result.time;
                }

                if (result.mistakes && Array.isArray(result.mistakes)) {
                    for (let i = 0; i < result.mistakes.length; i++) {
                        let m = result.mistakes[i];
                        let exist = false;
                        for (let j = 0; j < data.mistakes.length; j++) {
                            if (data.mistakes[j].q === m.q) {
                                data.mistakes[j].count = (data.mistakes[j].count || 0) + 1;
                                exist = true;
                                break;
                            }
                        }
                        if (!exist) data.mistakes.push({ q: m.q, a: m.correctAns, count: 1 });
                    }
                }

                if (result.correctOnes && Array.isArray(result.correctOnes)) {
                    data.mistakes = data.mistakes.filter(m => !result.correctOnes.includes(m.q));
                }

                await putUser(name, data);

                // 更新排行榜（D1 表）
                if (result.exp > 0) {
                    await env.battle_rooms.prepare(
                        "INSERT OR REPLACE INTO leaderboard (name, exp, level, avatar) VALUES (?, ?, ?, ?)"
                    ).bind(name, data.exp, data.level, data.currentAvatar).run();
                }

                return jsonRes({
                    user: data,
                    leveledUp: leveledUp,
                    oldLevel: oldLevel,
                    newLevel: data.level,
                    newUnlocks: newUnlocks,
                    exp: result.exp,
                    coins: result.coinsGained
                });
            }

            // ==========================================
            // API 3：行为处理 (商店与换装)
            // ==========================================
            if (pathname === "/api/action" && request.method === "POST") {
                if (!checkD1()) return jsonRes({ error: "未绑定 D1 数据库" }, 500);
                const { name, action, payload } = await request.json();
                let data = await getUser(name);
                if (!data) return jsonRes({ error: "未找到用户数据，请重新登录" }, 400);

                let success = false, msg = "";

                if (action === 'buy') {
                    let isTheme = payload.type === 'theme';
                    let unlockList = isTheme ? (data.unlockedThemes || []) : (data.unlockedAvatars || []);

                    if (payload.reqStreak && (data.streak || 0) < payload.reqStreak) {
                        msg = "需连续登录 " + payload.reqStreak + " 天才能解锁！";
                    } else if ((data.coins || 0) >= payload.cost && !unlockList.includes(payload.id)) {
                        data.coins -= payload.cost;
                        unlockList.push(payload.id);
                        if (isTheme) data.unlockedThemes = unlockList;
                        else data.unlockedAvatars = unlockList;
                        success = true;
                    } else {
                        msg = "金币不足或已拥有";
                    }
                } else if (action === 'equip') {
                    if (payload.type === 'theme' && (data.unlockedThemes || []).includes(payload.id)) {
                        data.currentTheme = payload.id;
                        success = true;
                    } else if (payload.type === 'avatar' && (data.unlockedAvatars || []).includes(payload.id)) {
                        data.currentAvatar = payload.id;
                        success = true;
                    }
                }

                await putUser(name, data);

                // 换头像时同步更新排行榜
                if (success && action === 'equip' && payload.type === 'avatar') {
                    await env.battle_rooms.prepare(
                        "UPDATE leaderboard SET avatar = ? WHERE name = ?"
                    ).bind(data.currentAvatar, name).run();
                }

                return jsonRes({ success, msg, user: data });
            }

            // ==========================================
            // API 4：排行榜获取
            // ==========================================
            if (pathname === "/api/leaderboard") {
                if (!checkD1()) return jsonRes([]);
                const { results } = await env.battle_rooms.prepare(
                    "SELECT name, exp, level, avatar FROM leaderboard ORDER BY exp DESC LIMIT 50"
                ).all();
                return jsonRes(results || []);
            }

            // ==========================================
            // D1 辅助函数：对战房间读写
            // ==========================================

            async function getRoom(code) {
                const row = await env.battle_rooms.prepare(
                    "SELECT data FROM rooms WHERE code = ?"
                ).bind(code).first();
                return row ? row.data : null;
            }

            async function putRoom(code, roomObj) {
                const data = JSON.stringify(roomObj);
                await env.battle_rooms.prepare(
                    "INSERT OR REPLACE INTO rooms (code, data, last_activity) VALUES (?, ?, ?)"
                ).bind(code, data, Date.now()).run();
            }

            async function deleteRoom(code) {
                await env.battle_rooms.prepare(
                    "DELETE FROM rooms WHERE code = ?"
                ).bind(code).run();
            }

            // 原子化更新房间：乐观锁防并发覆盖
            // modifyFn 接收 room 对象并直接修改它
            async function updateRoomSafe(code, modifyFn) {
                for (let attempt = 0; attempt < 5; attempt++) {
                    const oldData = await getRoom(code);
                    if (!oldData) return null;
                    const room = JSON.parse(oldData);
                    modifyFn(room);
                    room.lastActivity = Date.now();
                    const newData = JSON.stringify(room);
                    // 乐观锁：只有在数据没被其他请求修改时才写入
                    const result = await env.battle_rooms.prepare(
                        "UPDATE rooms SET data = ?, last_activity = ? WHERE code = ? AND data = ?"
                    ).bind(newData, Date.now(), code, oldData).run();
                    if (result.meta.changes > 0) return room;
                    // 数据已被其他请求修改，用最新数据重试
                }
                return null;
            }

            // ==========================================
            // API 5：多人对战 - 创建与加入（D1 强一致）
            // ==========================================
            if (pathname === "/api/battle/join" && request.method === "POST") {
                if (!checkD1()) return jsonRes({ error: "未绑定 D1 数据库 battle_rooms" }, 500);

                const { action, name, avatar, roomCode, grade, types, count } = await request.json();
                let roomStr = await getRoom(roomCode);
                let room;
                const now = Date.now();

                if (action === 'create') {
                    if (roomStr) return jsonRes({ error: '房间号生成冲突，请重新点击创建' }, 400);
                    room = {
                        code: roomCode,
                        host: name,
                        players: [{ name, avatar, progress: 0, finished: false, time: 0, accuracy: 0, combo: 0, tauntMsg: '', tauntTime: 0, isReady: true }],
                        status: 'waiting',
                        config: { grade, types, count },
                        createdAt: now,
                        startedAt: 0,
                        questions: []
                    };
                } else if (action === 'join') {
                    if (!roomStr) return jsonRes({ error: '房间不存在或已解散！' }, 404);
                    room = JSON.parse(roomStr);
                    if (room.status === 'playing' || room.status === 'finished') return jsonRes({ error: '房间已在游戏中或已结束' }, 400);

                    if (!room.players.find(p => p.name === name)) {
                        if (room.players.length >= 4) return jsonRes({ error: '房间已满(最多4人)' }, 400);
                        room.players.push({ name, avatar, progress: 0, finished: false, time: 0, accuracy: 0, combo: 0, tauntMsg: '', tauntTime: 0, isReady: false });
                    }
                } else {
                    return jsonRes({ error: '无效的操作' }, 400);
                }

                room.lastActivity = now;
                await putRoom(roomCode, room);
                return jsonRes({ room });
            }

            // ==========================================
            // API 5.5: 成员主动准备（D1 强一致）
            // ==========================================
            if (pathname === "/api/battle/ready" && request.method === "POST") {
                if (!checkD1()) return jsonRes({ error: "未绑定 D1 数据库 battle_rooms" }, 500);
                const { roomCode, name } = await request.json();
                const room = await updateRoomSafe(roomCode, (r) => {
                    let player = r.players.find(p => p.name === name);
                    if (player) player.isReady = true;
                });
                if (!room) return jsonRes({ error: '房间不存在' }, 404);
                return jsonRes({ room });
            }

            // ==========================================
            // API 6：多人对战 - 离开与销毁（D1 强一致）
            // ==========================================
            if (pathname === "/api/battle/leave" && request.method === "POST") {
                if (!checkD1()) return jsonRes({ error: "未绑定 D1 数据库 battle_rooms" }, 500);
                const { roomCode, name } = await request.json();
                let roomStr = await getRoom(roomCode);
                if (roomStr) {
                    let room = JSON.parse(roomStr);
                    room.players = room.players.filter(p => p.name !== name);
                    if (room.players.length === 0) {
                        await deleteRoom(roomCode);
                        return jsonRes({ deleted: true });
                    } else {
                        if (room.host === name) room.host = room.players[0].name;
                        if (room.players.every(p => p.finished)) room.status = 'finished';
                        await putRoom(roomCode, room);
                        return jsonRes({ room });
                    }
                }
                return jsonRes({ success: true });
            }

            // ==========================================
            // API 7：多人对战 - 开始游戏（D1 强一致）
            // ==========================================
            if (pathname === "/api/battle/start" && request.method === "POST") {
                if (!checkD1()) return jsonRes({ error: "未绑定 D1 数据库 battle_rooms" }, 500);
                const { roomCode, questions } = await request.json();
                let roomStr = await getRoom(roomCode);
                if (!roomStr) return jsonRes({ error: '房间不存在' }, 404);
                let room = JSON.parse(roomStr);
                room.status = 'playing';
                room.startedAt = Date.now();
                room.questions = questions;
                room.lastActivity = Date.now();
                await putRoom(roomCode, room);
                return jsonRes({ room });
            }

            // ==========================================
            // API 8：多人对战 - 进度与同步（D1 强一致）
            // ==========================================
            if (pathname === "/api/battle/update" && request.method === "POST") {
                if (!checkD1()) return jsonRes({ error: "未绑定 D1 数据库 battle_rooms" }, 500);
                const { roomCode, name, progress, finished, time, accuracy, combo, taunt, status, questions } = await request.json();
                const room = await updateRoomSafe(roomCode, (r) => {
                    if (status === 'playing' && r.status === 'waiting') {
                        r.status = 'playing';
                    }
                    if (questions && questions.length > 0 && r.questions.length === 0) {
                        r.questions = questions;
                    }
                    let player = r.players.find(p => p.name === name);
                    if (player) {
                        player.progress = progress;
                        player.finished = finished || false;
                        player.time = time || 0;
                        player.accuracy = accuracy || 0;
                        player.combo = combo || 0;
                        if (taunt) {
                            r.players.forEach(p => {
                                if (p.name !== name) {
                                    p.tauntMsg = taunt;
                                    p.tauntFrom = name;
                                    p.tauntTime = Date.now();
                                }
                            });
                        }
                    }
                    if (r.players.every(p => p.finished)) {
                        r.status = 'finished';
                    }
                });
                if (!room) return jsonRes({ error: '房间不存在' }, 404);
                return jsonRes({ room });
            }

            // ==========================================
            // API 9：多人对战 - 轮询心跳（D1 强一致）
            // ==========================================
            if (pathname === "/api/battle/poll" && request.method === "POST") {
                if (!checkD1()) return jsonRes({ error: "未绑定 D1 数据库 battle_rooms" }, 500);
                const { roomCode } = await request.json();
                let roomStr = await getRoom(roomCode);
                if (!roomStr) return jsonRes({ error: '房间不存在' }, 404);
                return jsonRes(JSON.parse(roomStr));
            }

            // ==========================================
            // API 10：多人对战 - 重置房间（再来一局）
            // ==========================================
            if (pathname === "/api/battle/reset" && request.method === "POST") {
                if (!checkD1()) return jsonRes({ error: "未绑定 D1 数据库 battle_rooms" }, 500);
                const { roomCode } = await request.json();
                const room = await updateRoomSafe(roomCode, (r) => {
                    r.status = 'waiting';
                    r.questions = [];
                    r.startedAt = 0;
                    r.players.forEach(p => {
                        p.progress = 0;
                        p.finished = false;
                        p.time = 0;
                        p.accuracy = 0;
                        p.combo = 0;
                        p.tauntMsg = '';
                        p.tauntTime = 0;
                        if (p.name !== r.host) p.isReady = false;
                    });
                });
                if (!room) return jsonRes({ error: '房间不存在' }, 404);
                return jsonRes({ room });
            }

            // ==========================================
            // API 10.5：多人对战 - 修改房间配置
            // ==========================================
            if (pathname === "/api/battle/config" && request.method === "POST") {
                if (!checkD1()) return jsonRes({ error: "未绑定 D1 数据库 battle_rooms" }, 500);
                const { roomCode, grade, types, count } = await request.json();
                const room = await updateRoomSafe(roomCode, (r) => {
                    r.config = { grade: grade || 'g34', types: types || [], count: count || 10 };
                });
                if (!room) return jsonRes({ error: '房间不存在' }, 404);
                return jsonRes({ room });
            }

            // ==========================================
            // API 11：多人对战 - 结算金币
            // ==========================================
            if (pathname === "/api/battle/save-coins" && request.method === "POST") {
                const { name, coins } = await request.json();
                let data = await getUser(name);
                if (!data) return jsonRes({ error: '用户不存在' }, 404);
                data.coins += coins;
                await putUser(name, data);
                return jsonRes({ coins: data.coins });
            }

        } catch (err) {
            return jsonRes({ error: err.message || "服务器发生未知错误" }, 500);
        }

        return new Response(htmlContent, { headers: { "Content-Type": "text/html;charset=UTF-8", ...corsHeaders } });
    }
};

const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>速算英雄：终极传说版</title>
    <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;700;800;900&family=Fredoka+One&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com/3.4.1"></script>
    <style>
        :root { 
            --bg-start: #FFE8F4; --bg-mid: #FFF5E4; --bg-end: #E4F5FF; 
            --card-grad-1: #FF6B8A; --card-grad-2: #FF9F43; --card-grad-3: #FFD700; 
            --primary-start: #FF9A9E; --primary-end: #FF6B8A; 
            --text-main: #EC4899; 
            --border-main: #FBCFE8; 
            --bg-light: #FDF2F8; 
        }
        * { font-family: "Nunito", sans-serif; }
        .title-font { font-family: "Fredoka One", cursive; }
        body { touch-action: manipulation; overflow-x: hidden; }
        
        .theme-gradient-bg { background: linear-gradient(to bottom right, var(--bg-start), var(--bg-mid), var(--bg-end)); }
        .theme-hero-card { background: linear-gradient(135deg, var(--card-grad-1), var(--card-grad-2), var(--card-grad-3)); }
        .bg-theme-light { background-color: var(--bg-light); }
        .text-theme-main { color: var(--text-main); }
        .border-theme-main { border-color: var(--border-main); }

        .bubble-bg::before { 
            content: '⭐🌟💫✨🎈🎀🎊🌈'; font-size: 1.5rem; position: fixed; 
            top: -20px; left: 0; width: 100%; white-space: nowrap; letter-spacing: 3rem; 
            opacity: 0.12; animation: floatEmoji 8s linear infinite; pointer-events: none; z-index: 0; 
        }
        @keyframes floatEmoji { 0% { transform: translateY(-20px); } 100% { transform: translateY(110vh); } }

        .main-panel { border-radius: 2rem; box-shadow: 0 8px 0 rgba(0,0,0,0.08), 0 2px 20px rgba(0,0,0,0.08); }
        .ghost-bear { opacity: 0.35; filter: grayscale(80%); transition: left 0.5s linear; }
        .progress-line { background-image: radial-gradient(#e5e7eb 1.5px, transparent 1.5px); background-size: 12px 12px; }
        .exp-bar-fill { transition: width 1s cubic-bezier(0.34, 1.56, 0.64, 1); }
        
        .shake { animation: shake 0.4s both; }
        @keyframes shake { 
            10%,90%{transform:translate3d(-2px,0,0)} 
            20%,80%{transform:translate3d(3px,0,0)} 
            30%,50%,70%{transform:translate3d(-4px,0,0)} 
            40%,60%{transform:translate3d(4px,0,0)} 
        }
        
        .animate-pop { animation: popOut 0.9s ease-out forwards; }
        @keyframes popOut { 0%{opacity:0;transform:scale(0.3) translateY(10px)} 40%{opacity:1;transform:scale(1.3)} 100%{opacity:0;transform:translateY(-40px) scale(0.8)} }

        .taunt-popup { animation: tauntPop 3s ease forwards; }
        @keyframes tauntPop { 0%{opacity:0;transform:translateY(20px) scale(0.5)} 15%{opacity:1;transform:translateY(-5px) scale(1.1)} 25%{transform:scale(1)} 75%{opacity:1;transform:scale(1)} 100%{opacity:0;transform:translateY(-30px)} }

        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #fbbf8c; border-radius: 10px; }
        
        .modal-enter { animation: modalIn 0.35s cubic-bezier(0.34,1.56,0.64,1) forwards; }
        @keyframes modalIn { from{opacity:0;transform:scale(0.7) translateY(30px)}to{opacity:1;transform:scale(1) translateY(0)} }

        .btn-cute { position: relative; border-radius: 1rem; border: none; cursor: pointer; font-weight: 900; transition: all 0.1s ease; box-shadow: 0 5px 0 rgba(0,0,0,0.15); }
        .btn-cute:active { transform: translateY(3px); box-shadow: 0 2px 0 rgba(0,0,0,0.15); }
        .btn-primary { background: linear-gradient(135deg, var(--primary-start), var(--primary-end)); color: white; }
        .btn-warning { background: linear-gradient(135deg, #FECD73, #FF9F43); color: white; }
        .btn-purple-custom { background: linear-gradient(135deg, #C084FC, #818CF8); color: white; box-shadow: 0 5px 0 #7C3AED; }
        .btn-purple-custom:active { box-shadow: 0 2px 0 #7C3AED; }

        .radio-peer:checked ~ .radio-label { border-color: var(--primary-start) !important; background-color: var(--bg-light) !important; color: var(--text-main) !important; }

        .deco-star::after { content: '⭐'; position: absolute; font-size: 1.2rem; animation: twinkle 2s ease-in-out infinite; }
        @keyframes twinkle { 0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(0.8)} }

        .keypad-btn { background: white; border-radius: 1rem; font-weight: 900; font-size: 1.5rem; color: #374151; box-shadow: 0 4px 0 #CBD5E1; border: 2px solid #F1F5F9; transition: all 0.1s; cursor: pointer; padding: 1rem 0; }
        .keypad-btn:active { transform: translateY(3px); box-shadow: 0 1px 0 #CBD5E1; }

        .player-track { background: linear-gradient(90deg, #FFF3C8, #C8EAFF); border-bottom: 3px solid rgba(0,0,0,0.06); position: relative; overflow: hidden; }
        .player-track::before { content: ''; position: absolute; inset: 0; background-image: repeating-linear-gradient(90deg, transparent, transparent 28px, rgba(255,255,255,0.6) 28px, rgba(255,255,255,0.6) 30px); }

        .room-code-display { background: linear-gradient(135deg, #FFF3C8, #FFE4A0); border: 3px dashed #FBBF24; border-radius: 1.5rem; padding: 1rem 2rem; text-align: center; }
        
        .dot-bounce { display: inline-block; animation: dotBounce 1.2s ease infinite; }
        .dot-bounce:nth-child(2) { animation-delay: 0.2s; }
        .dot-bounce:nth-child(3) { animation-delay: 0.4s; }
        @keyframes dotBounce { 0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)} }

        .rainbow-text { background: linear-gradient(135deg, #FF6B8A, #FF9F43, #FFD700, #6EE7B7, #60A5FA, #C084FC); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }

        .battle-track { background: linear-gradient(90deg, #FFF9C4, #E0F7FA); border-radius: 1rem; padding: 0.5rem 0.75rem; position: relative; overflow: hidden; height: 48px; border: 2px solid rgba(255,255,255,0.8); box-shadow: inset 0 2px 4px rgba(0,0,0,0.05); }
        .battle-track::before { content: ''; position: absolute; inset: 0; background-image: repeating-linear-gradient(90deg, transparent, transparent 18px, rgba(255,255,255,0.7) 18px, rgba(255,255,255,0.7) 20px); }
        .finish-flag { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); font-size: 1.25rem; z-index: 5; }
    </style>
</head>
<body id="main-body" class="bubble-bg theme-gradient-bg text-gray-800 min-h-screen flex items-center justify-center p-3 relative transition-colors duration-500">

    <div id="app" class="w-full max-w-md bg-white/95 backdrop-blur-sm main-panel border-4 border-white overflow-hidden relative z-10 min-h-[600px] flex flex-col">
        
        <!-- ================= 页面 1：登录界面 ================= -->
        <div id="screen-login" class="p-8 flex flex-col items-center justify-center flex-grow gap-5">
            <div class="relative mt-6">
                <div class="text-8xl" style="animation: bounce 1s ease infinite alternate; display:inline-block">🎮</div>
                <div class="absolute -top-2 -right-2 text-3xl" style="animation: twinkle 1.5s ease infinite">⭐</div>
            </div>
            <h1 class="title-font text-4xl text-theme-main text-center leading-tight">速算英雄传</h1>
            <p class="text-theme-main font-bold text-sm bg-theme-light px-4 py-2 rounded-full border-2 border-theme-main">🌟 每天练习，成为数学小天才！</p>
            
            <div class="w-full space-y-4 mt-4">
                <div class="relative">
                    <span class="absolute left-4 top-1/2 -translate-y-1/2 text-2xl">🦸</span>
                    <input type="text" id="input-nickname" placeholder="输入你的英雄代号..." 
                        class="w-full pl-12 pr-4 py-4 rounded-2xl border-2 border-theme-main focus:border-theme-main outline-none text-center font-black text-xl text-theme-main shadow-inner bg-theme-light">
                </div>
                <button id="btn-login" class="btn-cute btn-primary w-full py-4 text-xl font-black tracking-wide">
                    ✨ 踏上征程 ✨
                </button>
            </div>

            <div class="flex gap-3 mt-2 w-full">
                <div class="mock-btn btn-cute flex-1 bg-yellow-50 rounded-2xl p-3 text-center border-2 border-yellow-100 text-yellow-600 shadow-none">
                    <div class="text-2xl mb-1">🏆</div>
                    <div class="text-xs font-bold">全服排行</div>
                </div>
                <div class="mock-btn btn-cute flex-1 bg-blue-50 rounded-2xl p-3 text-center border-2 border-blue-100 text-blue-600 shadow-none">
                    <div class="text-2xl mb-1">⚔️</div>
                    <div class="text-xs font-bold">多人对战</div>
                </div>
                <div class="mock-btn btn-cute flex-1 bg-green-50 rounded-2xl p-3 text-center border-2 border-green-100 text-green-600 shadow-none">
                    <div class="text-2xl mb-1">🎁</div>
                    <div class="text-xs font-bold">皮肤商店</div>
                </div>
            </div>
        </div>

        <!-- ================= 页面 2：营地主页 ================= -->
        <div id="screen-setup" class="hidden p-4 flex flex-col gap-3 overflow-y-auto custom-scrollbar h-full">
            <div class="relative rounded-3xl p-4 text-white shadow-lg overflow-hidden theme-hero-card">
                <div class="absolute top-0 right-0 text-6xl opacity-10 rotate-12 -mr-2 -mt-2">⭐</div>
                <div class="absolute bottom-0 left-0 text-5xl opacity-10 -ml-2 -mb-2">🌟</div>
                
                <div class="relative z-10 flex items-center gap-3">
                    <div class="relative cursor-pointer group" id="btn-open-wardrobe">
                        <div class="text-5xl bg-white/25 p-2 rounded-2xl shadow-inner transition-transform group-active:scale-90 flex items-center justify-center min-w-[64px] min-h-[64px] border-3 border-white/30" id="avatar-emoji" style="border-width:3px">🐻</div>
                        <div class="absolute -bottom-2 -right-2 bg-white text-theme-main text-[9px] font-black px-1.5 py-0.5 rounded-full shadow">换装</div>
                    </div>
                    <div class="flex-grow min-w-0">
                        <div class="flex justify-between items-center mb-1">
                            <span class="font-black text-lg truncate" id="display-name">英雄</span>
                            <div class="flex items-center gap-1">
                                <button onclick="if(document.fullscreenElement){document.exitFullscreen()}else{document.documentElement.requestFullscreen().catch(()=>{})}" class="bg-white/25 text-white text-[10px] font-bold px-2 py-0.5 rounded-full active:bg-white/40">⛶</button>
                                <span class="text-[10px] font-bold bg-white/25 px-2 py-0.5 rounded-full" id="display-rank">新手</span>
                            </div>
                        </div>
                        <div class="w-full bg-black/20 h-3.5 rounded-full overflow-hidden mb-1" style="border: 2px solid rgba(255,255,255,0.3)"><div id="exp-bar" class="bg-white h-full exp-bar-fill rounded-full" style="width:0%"></div></div>
                        <div class="flex justify-between text-[11px] font-bold opacity-90">
                            <span id="display-lv">LV.1</span>
                            <span id="display-exp-text">0/30 EXP</span>
                        </div>
                    </div>
                </div>
                
                <div class="relative z-10 mt-3 flex gap-2 border-t border-white/20 pt-3">
                    <div class="bg-white/20 rounded-xl px-3 py-1.5 flex items-center text-sm font-bold flex-1">
                        <span class="mr-1 text-lg">🪙</span> <span id="display-coins">0</span> 金币
                    </div>
                    <div class="bg-white/20 rounded-xl px-3 py-1.5 flex items-center justify-between text-sm font-bold flex-1 cursor-pointer hover:bg-white/30 transition-colors" id="btn-signin">
                        <div><span class="mr-1 text-lg">🔥</span> <span id="display-streak">1</span> 天</div>
                        <span class="bg-red-500 text-white text-[9px] px-1.5 py-0.5 rounded shadow-sm">签到</span>
                    </div>
                </div>
            </div>

            <div class="grid grid-cols-4 gap-2">
                <button class="mode-tab active btn-cute p-2 rounded-xl font-black text-[11px] transition-all" data-mode="normal" style="background:var(--bg-light);color:var(--text-main);border:2px solid var(--primary-start);box-shadow:0 4px 0 var(--primary-start)">🎯 常规</button>
                <button class="mode-tab btn-cute p-2 rounded-xl font-black text-[11px] transition-all" id="btn-mistake-mode" data-mode="mistake" style="background:#F3F4F6;color:#9CA3AF;border:none;box-shadow:0 4px 0 #D1D5DB">🚨 错题</button>
                <button class="btn-cute btn-warning p-2 rounded-xl font-black text-[11px]" id="btn-open-shop">🛒 商店</button>
                <button class="btn-cute btn-purple-custom p-2 rounded-xl font-black text-[11px]" id="btn-open-leaderboard">🏆 榜单</button>
            </div>

            <button id="btn-open-battle" class="btn-cute btn-primary w-full py-3 rounded-2xl font-black text-base text-white flex items-center justify-center gap-2">
                ⚔️ 多人对战房间 <span class="text-xs bg-white/20 px-2 py-0.5 rounded-full">1-4人</span>
            </button>

            <div id="normal-config" class="space-y-3 flex-grow flex flex-col">
                <div>
                    <h2 class="font-black text-gray-500 text-xs mb-2 flex items-center gap-1"><span class="text-base">🎓</span> 选择年级</h2>
                    <div class="grid grid-cols-3 gap-2" id="grade-radios">
                        <label class="cursor-pointer flex-1 relative"><input type="radio" name="grade" value="g12" class="sr-only radio-peer">
                        <div class="p-2 text-center border-2 rounded-xl radio-label font-bold text-[12px] bg-white border-gray-200 transition-all text-gray-500">一二年级</div></label>
                        <label class="cursor-pointer flex-1 relative"><input type="radio" name="grade" value="g34" class="sr-only radio-peer" checked>
                        <div class="p-2 text-center border-2 rounded-xl radio-label font-bold text-[12px] bg-white border-gray-200 transition-all text-gray-500">三四年级</div></label>
                        <label class="cursor-pointer flex-1 relative"><input type="radio" name="grade" value="g56" class="sr-only radio-peer"><div class="p-2 text-center border-2 rounded-xl radio-label font-bold text-[12px] bg-white border-gray-200 transition-all text-gray-500">五六年级</div></label>
                    </div>
                </div>
                <div class="flex-grow flex flex-col min-h-0">
                    <h2 class="font-black text-gray-500 text-xs mb-2 flex items-center gap-1"><span class="text-base">✏️</span> 选择题型 <span class="text-gray-400 font-normal text-[10px]">(难度高经验多)</span></h2>
                    <div id="type-checkboxes" class="grid grid-cols-1 sm:grid-cols-2 gap-2 overflow-y-auto pr-1 custom-scrollbar pb-1"></div>
                </div>
            </div>

            <div id="mistake-config" class="hidden flex-grow flex items-center justify-center">
                <div class="bg-red-50 p-6 rounded-3xl border-3 border-red-100 text-center w-full" style="border-width:3px">
                    <div class="text-5xl mb-2">📚</div>
                    <p class="text-red-400 font-black text-lg">错题库: <span id="mistake-count" class="text-3xl text-red-500">0</span> 题</p>
                    <p class="text-sm text-red-300 font-bold mt-1">攻克它们！</p>
                </div>
            </div>

            <div class="mt-auto pt-2">
                <div class="grid grid-cols-3 gap-2 mb-3" id="count-radios">
                    <label class="cursor-pointer relative"><input type="radio" name="count" value="10" class="sr-only radio-peer">
                    <div class="p-2 text-center border-2 rounded-xl radio-label font-black bg-white border-gray-200 text-sm text-gray-500">10题</div></label>
                    <label class="cursor-pointer relative"><input type="radio" name="count" value="20" class="sr-only radio-peer" checked>
                    <div class="p-2 text-center border-2 rounded-xl radio-label font-black bg-white border-gray-200 text-sm text-gray-500">20题</div></label>
                    <label class="cursor-pointer relative"><input type="radio" name="count" value="30" class="sr-only radio-peer">
                    <div class="p-2 text-center border-2 rounded-xl radio-label font-black bg-white border-gray-200 text-sm text-gray-500">30题</div></label>
                </div>
                <button id="btn-start" class="btn-cute btn-primary w-full py-4 rounded-2xl text-white text-xl font-black tracking-wide">
                    个人挑战 🏃
                </button>
            </div>
        </div>

        <!-- ================= 页面 3：单人答题 ================= -->
        <div id="screen-play" class="hidden flex-col h-full flex-grow relative" style="background:#FAFBFF">
            <div id="combo-display" class="absolute top-28 right-3 text-4xl font-black text-orange-500 opacity-0 pointer-events-none z-20" style="-webkit-text-stroke: 1.5px white; text-shadow: 0 2px 8px rgba(0,0,0,0.2)"></div>
            <div class="px-4 pt-4 pb-2 bg-white flex justify-between items-center" style="border-bottom: 3px solid #F3F4F6">
                <span class="text-theme-main font-black bg-theme-light px-3 py-1.5 rounded-xl text-sm border-2 border-theme-main" id="progress-text">第 1 / 20 题</span>
                <span class="text-orange-500 font-mono font-black bg-orange-50 px-3 py-1.5 rounded-xl border-2 border-orange-100 text-sm" id="timer-text">00.0s</span>
            </div>
            <div class="w-full player-track h-12 relative">
                <div id="ghost-bear" class="ghost-bear absolute top-1 text-2xl z-10 hidden transition-all" style="left:0%;top:50%;transform:translateY(-50%)">🤖</div>
                <div id="player-bear" class="absolute text-2xl z-20 transition-all duration-300" style="left:0%;top:50%;transform:translateY(-50%)">🐻</div>
                <div class="absolute right-1 top-1/2 -translate-y-1/2 text-xl z-10">🏁</div>
            </div>
            <div class="flex-grow flex flex-col items-center justify-center px-6 py-4">
                <div id="question-text" class="text-5xl font-black text-gray-700 mb-6 flex items-center justify-center flex-wrap w-full text-center gap-2 drop-shadow-sm"></div>
                <div id="answer-display" class="w-full h-20 bg-white rounded-3xl text-4xl font-black flex items-center justify-center text-theme-main transition-all relative border-theme-main" style="border-width: 4px; box-shadow: 0 4px 0 var(--border-main), inset 0 2px 8px rgba(0,0,0,0.04)">
                    <span id="answer-value" class="animate-pulse border-r-4 border-theme-main pr-2"></span>
                </div>
            </div>
            <div class="p-3 grid grid-cols-4 gap-2 pb-6" style="background:#F8FAFF; border-top: 3px solid #EEF2FF">
                <button class="single-keypad-btn keypad-btn" data-val="1">1</button>
                <button class="single-keypad-btn keypad-btn" data-val="2">2</button>
                <button class="single-keypad-btn keypad-btn" data-val="3">3</button>
                <button class="single-keypad-btn keypad-btn" data-val="del" style="background:linear-gradient(135deg,#FCA5A5,#F87171);color:white;box-shadow:0 4px 0 #EF4444;font-size:1rem">删除</button>
                <button class="single-keypad-btn keypad-btn" data-val="4">4</button>
                <button class="single-keypad-btn keypad-btn" data-val="5">5</button>
                <button class="single-keypad-btn keypad-btn" data-val="6">6</button>
                <button class="single-keypad-btn keypad-btn row-span-3 btn-primary" data-val="enter" style="font-size:1.1rem; box-shadow: 0 4px 0 var(--primary-end);">确<br>认</button>
                <button class="single-keypad-btn keypad-btn" data-val="7">7</button>
                <button class="single-keypad-btn keypad-btn" data-val="8">8</button>
                <button class="single-keypad-btn keypad-btn" data-val="9">9</button>
                <button class="single-keypad-btn keypad-btn col-span-2" data-val="0">0</button>
                <button class="single-keypad-btn keypad-btn" data-val=".">.</button>
            </div>
        </div>

        <!-- ================= 页面 4：单人结算 ================= -->
        <div id="screen-result" class="hidden p-6 flex-col items-center flex-grow justify-center">
            <div id="result-badge" class="text-7xl mb-3" style="animation: bounce 0.8s ease infinite alternate; display:block; text-align:center">🏆</div>
            <h2 id="result-msg" class="title-font text-3xl text-theme-main mb-2 text-center">太厉害了！</h2>
            <p class="text-gray-400 font-bold text-sm mb-5">挑战完成！</p>
            <div class="w-full space-y-3 mb-6">
                <div class="flex justify-between items-center p-4 rounded-2xl relative overflow-hidden border-2 bg-theme-light border-theme-main">
                    <span class="font-bold text-theme-main">⏱️ 用时</span><span class="font-black text-theme-main text-2xl" id="final-time">00.0s</span>
                    <div id="pb-tag" class="hidden absolute inset-0 flex items-center justify-center font-black text-yellow-600 tracking-widest opacity-80" style="background:linear-gradient(135deg,rgba(253,230,138,0.7),rgba(251,191,36,0.6))">🏅 新纪录 PB!</div>
                </div>
                <div class="flex justify-between items-center p-4 rounded-2xl border-2" style="background:linear-gradient(135deg,#FFF5F5,#FFE4E4); border-color:#FECACA">
                    <span class="font-bold text-red-400">🎯 准确率</span><span class="font-black text-red-500 text-2xl" id="final-acc">100%</span>
                </div>
                <div class="flex justify-between items-center p-4 rounded-2xl border-2" style="background:linear-gradient(135deg,#F0FFF4,#DCFCE7); border-color:#BBF7D0">
                    <span class="font-bold text-green-500">✨ 经验</span><span class="font-black text-green-600 text-2xl" id="final-exp">+0 EXP</span>
                </div>
                <div class="flex justify-between items-center p-4 rounded-2xl border-2" style="background:linear-gradient(135deg,#FFFBEB,#FEF3C7); border-color:#FDE68A">
                    <span class="font-bold text-yellow-500">🪙 金币</span><span class="font-black text-yellow-600 text-2xl" id="final-coins">+0</span>
                </div>
            </div>
            <button id="btn-restart" class="btn-cute btn-primary w-full py-4 rounded-2xl text-white text-xl font-black mt-auto">⛺ 返回营地</button>
        </div>

        <!-- ================= 页面 5：多人大厅 ================= -->
        <div id="screen-battle-lobby" class="hidden p-5 flex-col flex-grow gap-4">
            <div class="flex items-center gap-2">
                <button id="btn-battle-back" class="btn-cute p-2 rounded-xl text-lg" style="background:#F3F4F6;box-shadow:0 3px 0 #D1D5DB">←</button>
                <h2 class="title-font text-2xl text-theme-main flex-grow">⚔️ 多人联机大厅</h2>
            </div>
            <div class="grid grid-cols-2 gap-3 mb-2">
                <button id="btn-create-room" class="btn-cute btn-purple-custom p-4 rounded-2xl font-black text-white flex flex-col items-center gap-2">
                    <span class="text-3xl">🏠</span><span>创建新房间</span><span class="text-xs opacity-80">当房主组局</span>
                </button>
                <button id="btn-join-room" class="btn-cute p-4 rounded-2xl font-black flex flex-col items-center gap-2 bg-gray-100 text-gray-400" style="box-shadow: 0 5px 0 #D1D5DB;">
                    <span class="text-3xl">🚪</span><span>加入房间</span><span class="text-xs opacity-80">输入房间码</span>
                </button>
            </div>
            <div id="join-room-input" class="hidden space-y-3">
                <input type="text" id="input-room-code" placeholder="输入4位数字房间码" maxlength="4" class="w-full p-4 rounded-2xl text-center font-black text-2xl text-theme-main outline-none uppercase bg-theme-light border-2 border-theme-main" style="letter-spacing:0.3em">
                <button id="btn-confirm-join" class="btn-cute btn-purple-custom w-full py-3 rounded-2xl font-black text-white">确认加入</button>
            </div>
            <div id="battle-config" class="space-y-3">
                <h3 class="font-black text-gray-500 text-sm">🎓 房主配置年级</h3>
                <div class="grid grid-cols-3 gap-2" id="battle-grade-radios">
                    <label class="cursor-pointer relative"><input type="radio" name="battleGrade" value="g12" class="sr-only radio-peer"><div class="p-2 text-center border-2 rounded-xl radio-label font-bold text-xs bg-white border-gray-200 text-gray-500">一二年级</div></label>
                    <label class="cursor-pointer relative"><input type="radio" name="battleGrade" value="g34" class="sr-only radio-peer" checked><div class="p-2 text-center border-2 rounded-xl radio-label font-bold text-xs bg-white border-gray-200 text-gray-500">三四年级</div></label>
                    <label class="cursor-pointer relative"><input type="radio" name="battleGrade" value="g56" class="sr-only radio-peer"><div class="p-2 text-center border-2 rounded-xl radio-label font-bold text-xs bg-white border-gray-200 text-gray-500">五六年级</div></label>
                </div>
                <h3 class="font-black text-gray-500 text-sm">✏️ 选择题型 (多选)</h3>
                <div id="battle-type-checkboxes" class="grid grid-cols-2 gap-2"></div>
                <h3 class="font-black text-gray-500 text-sm">📝 对战题数</h3>
                <div class="grid grid-cols-3 gap-2">
                    <label class="cursor-pointer relative"><input type="radio" name="battleCount" value="10" class="sr-only radio-peer" checked><div class="p-2 text-center border-2 rounded-xl radio-label font-bold text-xs bg-white border-gray-200 text-gray-500">10题</div></label>
                    <label class="cursor-pointer relative"><input type="radio" name="battleCount" value="20" class="sr-only radio-peer"><div class="p-2 text-center border-2 rounded-xl radio-label font-bold text-xs bg-white border-gray-200 text-gray-500">20题</div></label>
                    <label class="cursor-pointer relative"><input type="radio" name="battleCount" value="30" class="sr-only radio-peer"><div class="p-2 text-center border-2 rounded-xl radio-label font-bold text-xs bg-white border-gray-200 text-gray-500">30题</div></label>
                </div>
            </div>
            <button id="btn-create-confirm" class="btn-cute btn-purple-custom hidden w-full py-4 rounded-2xl font-black text-white text-lg mt-auto">🏠 生成房间码并创建</button>
        </div>

        <!-- ================= 页面 6：等候室 ================= -->
        <div id="screen-battle-room" class="hidden p-5 flex-col flex-grow gap-4">
            <div class="flex items-center justify-between">
                <h2 class="title-font text-2xl text-theme-main">⚔️ 等候室</h2>
                <div class="room-code-display">
                    <div class="text-xs font-bold text-yellow-600 mb-1">告诉朋友房间码</div>
                    <div class="font-black text-3xl text-yellow-700 tracking-widest" id="display-room-code">----</div>
                </div>
            </div>
            <div class="bg-theme-light rounded-2xl p-3 border-2 border-theme-main flex-grow min-h-0 flex flex-col">
                <p class="text-xs font-bold text-theme-main mb-3 text-center">🎮 玩家列表 (支持2-4人)</p>
                <div id="room-players-list" class="space-y-2 overflow-y-auto custom-scrollbar pr-2 flex-1"></div>
            </div>
            <div class="bg-yellow-50 rounded-2xl p-3 border-2 border-yellow-100 text-center">
                <div class="text-xs font-bold text-yellow-600">⚡ 对战规则</div>
                <div class="text-[11px] text-yellow-500 mt-1 font-bold">答错罚时 10 秒！总用时定胜负！无经验加成</div>
            </div>
            <div id="room-config-section" class="hidden">
                <div class="bg-white rounded-2xl p-3 border-2 border-gray-100 space-y-2">
                    <div class="flex justify-between items-center">
                        <span class="text-xs font-black text-gray-500">🎓 年级</span>
                        <span class="text-xs font-bold text-theme-main" id="room-config-grade">三四年级</span>
                    </div>
                    <div class="flex justify-between items-center">
                        <span class="text-xs font-black text-gray-500">✏️ 题型</span>
                        <span class="text-xs font-bold text-theme-main" id="room-config-types">加法</span>
                    </div>
                    <div class="flex justify-between items-center">
                        <span class="text-xs font-black text-gray-500">📝 题数</span>
                        <span class="text-xs font-bold text-theme-main" id="room-config-count">10</span>
                    </div>
                    <button id="btn-edit-room-config" class="hidden btn-cute w-full py-2 rounded-xl font-bold text-xs text-purple-600 bg-purple-50 border-2 border-purple-200 mt-1">⚙️ 修改配置</button>
                </div>
            </div>
            <div class="mt-auto space-y-2">
                <button id="btn-start-battle" class="btn-cute btn-purple-custom hidden w-full py-4 rounded-2xl font-black text-white text-lg transition-all duration-300">等待成员加入... (1/4)</button>
                <button id="btn-ready-battle" class="btn-cute btn-warning hidden w-full py-4 rounded-2xl font-black text-white text-lg">🙋‍♂️ 准备</button>
                <div id="waiting-msg" class="text-center text-gray-400 font-bold text-sm bg-gray-100 py-3 rounded-xl border-2 border-gray-200 hidden"><span class="dot-bounce">●</span><span class="dot-bounce">●</span><span class="dot-bounce">●</span> 等待房主开始</div>
                <button id="btn-leave-room" class="btn-cute w-full py-3 rounded-xl font-bold text-gray-500" style="background:#F3F4F6;box-shadow:0 3px 0 #D1D5DB">退出房间</button>
            </div>
        </div>

        <!-- ================= 页面 7：多人答题 ================= -->
        <div id="screen-battle-play" class="hidden flex-col h-full flex-grow relative" style="background:#FAFBFF">
            <div id="battle-waiting-overlay" class="hidden absolute inset-0 bg-white/95 z-[60] flex-col items-center justify-center rounded-[2rem] p-6 text-center">
                <div class="text-6xl mb-4 animate-bounce">🏁</div>
                <div class="font-black text-3xl text-theme-main mb-2">已冲线！</div>
                <div class="font-bold text-gray-500 text-sm mb-6 flex items-center gap-2 justify-center"><span class="dot-bounce text-xl">●</span><span class="dot-bounce text-xl">●</span><span class="dot-bounce text-xl">●</span> 等待其他玩家完成...</div>
                <div class="bg-gray-100 rounded-2xl p-4 w-full">
                    <div class="text-xs font-bold text-gray-400 mb-1">你的总用时(含罚时)</div><div class="text-4xl font-black text-orange-500" id="battle-final-time-preview">00.0s</div>
                </div>
            </div>
            <div id="battle-taunt-display" class="hidden fixed top-2 left-0 right-0 z-50 flex justify-center pointer-events-none px-4">
                <div id="battle-taunt-bubble" class="taunt-popup bg-yellow-300 border-3 border-yellow-500 rounded-2xl px-4 py-2 shadow-lg pointer-events-none inline-flex items-center gap-2 max-w-[90%]" style="border-width:3px">
                    <span class="text-2xl flex-shrink-0" id="battle-taunt-icon">😈</span><span class="font-black text-yellow-900 text-sm truncate" id="battle-taunt-text"></span><span class="text-xs text-yellow-700 font-bold flex-shrink-0" id="battle-taunt-from"></span>
                </div>
            </div>
            <div class="bg-white px-3 pt-3 pb-2" style="border-bottom:3px solid #F3F4F6">
                <div class="flex justify-between text-sm mb-2"><span class="font-black text-theme-main bg-theme-light px-2 py-1 rounded-lg" id="battle-progress-text">第 1/10 题</span><span class="font-mono font-black text-orange-500 bg-orange-50 px-2 py-1 rounded-lg" id="battle-timer-text">00.0s</span></div>
                <div id="battle-tracks-container" class="space-y-1.5 overflow-y-auto max-h-32 custom-scrollbar pr-1"></div>
            </div>
            <div class="flex-grow flex flex-col items-center justify-center px-6 py-3 relative">
                <div id="battle-question-text" class="text-4xl sm:text-5xl font-black text-gray-700 mb-4 flex items-center justify-center flex-wrap w-full text-center gap-2"></div>
                <div id="battle-answer-display" class="relative w-full h-16 bg-white rounded-3xl text-4xl font-black flex items-center justify-center text-theme-main transition-all border-theme-main" style="border-width: 4px; box-shadow: 0 4px 0 var(--border-main)"><span id="battle-answer-value" class="animate-pulse">?</span></div>
            </div>
            <div id="battle-combo-display" class="text-center py-1 font-black text-orange-500 text-lg opacity-0 transition-opacity"></div>
            <div class="p-3 grid grid-cols-4 gap-2 pb-6" style="background:#F8FAFF; border-top:3px solid #EEF2FF">
                <button class="battle-keypad-btn keypad-btn" data-val="1">1</button>
                <button class="battle-keypad-btn keypad-btn" data-val="2">2</button>
                <button class="battle-keypad-btn keypad-btn" data-val="3">3</button>
                <button class="battle-keypad-btn keypad-btn" data-val="del" style="background:linear-gradient(135deg,#FCA5A5,#F87171);color:white;box-shadow:0 4px 0 #EF4444;font-size:1rem">删除</button>
                <button class="battle-keypad-btn keypad-btn" data-val="4">4</button>
                <button class="battle-keypad-btn keypad-btn" data-val="5">5</button>
                <button class="battle-keypad-btn keypad-btn" data-val="6">6</button>
                <button class="battle-keypad-btn keypad-btn row-span-3 btn-primary" data-val="enter" style="font-size:1.1rem;box-shadow:0 4px 0 var(--primary-end)">确<br>认</button>
                <button class="battle-keypad-btn keypad-btn" data-val="7">7</button>
                <button class="battle-keypad-btn keypad-btn" data-val="8">8</button>
                <button class="battle-keypad-btn keypad-btn" data-val="9">9</button>
                <button class="battle-keypad-btn keypad-btn col-span-2" data-val="0">0</button>
                <button class="battle-keypad-btn keypad-btn" data-val=".">.</button>
            </div>
        </div>

        <!-- ================= 页面 8：多人结算 ================= -->
        <div id="screen-battle-result" class="hidden p-6 flex-col items-center flex-grow">
            <div class="text-6xl text-center mb-2" id="battle-result-badge">🏆</div>
            <h2 class="title-font text-3xl rainbow-text mb-1 text-center" id="battle-result-msg">对战结果</h2>
            <p class="text-gray-400 font-bold text-sm mb-5">战局已定！(已计入罚时)</p>
            <div id="battle-rankings" class="w-full space-y-2 mb-6 flex-grow overflow-y-auto custom-scrollbar pr-1"></div>
            <div class="w-full bg-yellow-50 rounded-2xl p-4 border-2 border-yellow-100 mb-4 text-center shrink-0">
                <div class="text-sm font-bold text-yellow-600">🪙 参与奖金 <span class="text-[10px]">(×1.2倍)</span></div>
                <div class="text-3xl font-black text-yellow-600" id="battle-coins-earned">+0</div>
            </div>
            <div class="flex gap-2 mt-auto shrink-0">
                <button id="btn-battle-back-room" class="btn-cute flex-1 py-4 rounded-2xl font-black text-purple-600 text-lg bg-purple-50 border-2 border-purple-200">🔄 再来一局</button>
                <button id="btn-battle-restart" class="btn-cute flex-1 py-4 rounded-2xl font-black text-gray-500 text-lg bg-gray-100 border-2 border-gray-200">⛺ 回大厅</button>
            </div>
        </div>

    </div>

    <!-- ================= 弹窗与错误提示 ================= -->
    <div id="custom-alert" class="hidden fixed inset-0 z-[300] flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-black/50 backdrop-blur-sm"></div>
        <div class="relative bg-white rounded-[2rem] p-6 shadow-2xl max-w-sm w-full text-center">
            <div id="custom-alert-msg" class="text-gray-700 font-bold mb-6 whitespace-pre-wrap leading-relaxed text-sm"></div>
            <button onclick="window.hideCustomAlert()" class="btn-cute btn-primary w-full py-3 rounded-xl font-black text-white mt-4">知道了</button>
        </div>
    </div>

    <div id="modal-container" class="hidden fixed inset-0 z-[200] flex items-center justify-center p-4">
        <div id="modal-backdrop" class="absolute inset-0 bg-black/50 backdrop-blur-sm"></div>
        
        <div id="modal-shop" class="hidden relative z-10 w-full max-w-sm max-h-[85vh] bg-white rounded-[2rem] flex-col shadow-2xl modal-enter">
            <div class="p-4 border-b border-yellow-100 flex justify-between items-center bg-yellow-50 rounded-t-[2rem] shrink-0">
                <h3 class="font-black text-xl text-yellow-700">🛒 魔法小店</h3><div class="font-black text-yellow-600 bg-white px-3 py-1 rounded-full shadow-sm">🪙 <span id="shop-coin-display">0</span></div>
            </div>
            <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4"><div id="shop-items-container" class="space-y-6"></div></div>
            <div class="p-4 shrink-0 border-t border-gray-100"><button class="btn-close-modal btn-cute w-full bg-gray-100 text-gray-500 font-bold py-3 rounded-xl shadow-none">离开商店</button></div>
        </div>
        
        <div id="modal-wardrobe" class="hidden relative z-10 w-full max-w-sm max-h-[85vh] bg-white rounded-[2rem] flex-col shadow-2xl modal-enter">
            <div class="p-4 border-b border-theme-main bg-theme-light rounded-t-[2rem] shrink-0 text-center">
                <h3 class="font-black text-xl text-theme-main">👔 我的衣橱</h3><p class="text-xs text-theme-main mt-1">点击即时换装</p>
            </div>
            <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4"><div id="wardrobe-items-container" class="space-y-6"></div></div>
            <div class="p-4 shrink-0 border-t border-gray-100"><button class="btn-close-modal btn-cute w-full bg-gray-100 text-gray-500 font-bold py-3 rounded-xl shadow-none">穿好了 ✨</button></div>
        </div>
        
        <div id="modal-leaderboard" class="hidden relative z-10 w-full max-w-sm max-h-[85vh] bg-white rounded-[2rem] flex-col shadow-2xl modal-enter">
            <div class="p-4 border-b border-theme-main bg-theme-light rounded-t-[2rem] shrink-0 flex justify-between items-center">
                <h3 class="font-black text-xl text-theme-main">🏆 英雄排行榜</h3><span class="text-xs font-bold text-white bg-theme-main px-2 py-1 rounded-full">TOP 50</span>
            </div>
            <div class="overflow-y-auto custom-scrollbar flex-1 min-h-0" id="leaderboard-items-container"></div>
            <div class="p-4 shrink-0 border-t border-gray-100"><button class="btn-close-modal btn-cute w-full bg-gray-100 text-gray-500 font-bold py-3 rounded-xl shadow-none">关闭</button></div>
        </div>
        
        <div id="modal-levelup" class="hidden relative z-10 w-full max-w-sm bg-white rounded-[2rem] flex-col shadow-2xl modal-enter overflow-hidden items-center text-center pb-6">
            <div class="w-full pt-8 pb-4 text-7xl text-center" style="background:linear-gradient(135deg,#FFD700,#FF9F43)"><div style="animation:bounce 0.6s ease infinite alternate;display:inline-block">🎊</div></div>
            <div class="p-4 w-full">
                <h2 class="title-font text-3xl rainbow-text">升级啦！</h2><p class="text-gray-500 font-bold mt-1 mb-4">达到新境界 <span class="text-theme-main font-black text-2xl" id="levelup-number">LV.2</span></p>
                <div id="levelup-unlocks" class="hidden mb-4"><p class="text-xs font-bold text-gray-400 mb-2">🎁 获得解锁奖励</p><div class="flex justify-center gap-2" id="levelup-unlock-items"></div></div>
                <button class="btn-close-modal btn-cute btn-warning w-full py-3 rounded-2xl font-black text-white text-lg">太棒了！🎉</button>
            </div>
        </div>
    </div>

    <!-- ================= 前端核心 JS ================= -->
    <script>
    (function() {
        
        // 全局错误捕获
        window.onerror = function(msg, url, line, col, error) {
            console.error("Global Error:", msg, line, col, error);
        };

        function customAlert(htmlStr) {
            var el = document.getElementById("custom-alert-msg");
            if (el) el.innerHTML = htmlStr; 
            var box = document.getElementById("custom-alert");
            if (box) {
                box.classList.remove("hidden");
                box.classList.add("flex");
            }
        }
        window.customAlert = customAlert;

        function hideCustomAlert() {
            var box = document.getElementById("custom-alert");
            if (box) {
                box.classList.add("hidden");
                box.classList.remove("flex");
            }
        }
        window.hideCustomAlert = hideCustomAlert;
        
        // 【关键修复】：将所有 API 通信强制固定为 POST 请求，彻底穿透 CDN 和浏览器缓存
        async function apiFetch(url, options) {
            try {
                var res = await fetch(url, options);
                var text = await res.text();
                var data;
                try { 
                    data = JSON.parse(text); 
                } catch(e) { 
                    data = { error: text }; 
                }
                if (!res.ok) {
                    throw new Error(data.error || data.msg || '请求失败，请检查网络或后端配置');
                }
                return data;
            } catch (err) {
                console.error(err);
                customAlert("服务器通信失败：<br>" + err.message);
                throw err;
            }
        }

        document.querySelectorAll('.mock-btn').forEach(function(btn) {
            btn.onclick = function() { 
                customAlert("英雄，请先在上方输入你的代号，并点击【✨ 踏上征程 ✨】建立档案，然后才能解锁这些高级功能哦！"); 
            };
        });

        // ==========================================
        // 全局状态定义
        // ==========================================
        var user = { 
            name: "", level: 1, exp: 0, coins: 0, pbs: {}, mistakes: [], unlockedAvatars: ['🐻'], currentAvatar: '🐻', unlockedThemes: ['default'], currentTheme: 'default', streak: 1 
        };
        
        var game = { 
            questions: [], currentIndex: 0, mistakes: [], correctOnes: [], startTime: 0, timer: null, pbTime: 0, hasPb: false, mode: 'normal', currentInput: "", isProcessing: false, combo: 0, grade: 'g34', types: [], configKey: "" 
        };
        
        var battle = { 
            roomCode: "", isHost: false, pollInterval: null, grade: 'g34', types: [], count: 10, questions: [], currentIndex: 0, currentInput: "", isProcessing: false, combo: 0, startTime: 0, timer: null, mistakes: [], correctOnes: [], myProgress: 0, finished: false, tauntedMilestones: {}, timePenalty: 0 
        };

        // --- 补充缺失的 saveResult 函数 ---
        async function saveResult(accuracy, time, mistakes, correctOnes, configKey, grade, types) {
            var exp = 0;
            var coins = 0;
            // 根据正确题数基础经验
            var baseExp = correctOnes ? correctOnes.length * 5 : 0;
            // 年级倍率
            var gradeFactor = grade === 'g56' ? 1.5 : (grade === 'g34' ? 1.2 : 1.0);
            exp = Math.floor(baseExp * gradeFactor);
            if (accuracy === 100) exp += 10;
            
            coins = correctOnes ? correctOnes.length * 2 : 0;
            if (accuracy === 100) coins += 5;

            var payload = {
                name: user.name,
                result: {
                    exp: exp,
                    coinsGained: coins,
                    time: time,
                    mistakes: mistakes,
                    correctOnes: correctOnes,
                    accuracy: accuracy,
                    configKey: configKey
                }
            };
            return await apiFetch('/api/save-result', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify(payload)
            });
        }

        // ==========================================
        // 嘲讽库数据
        // ==========================================
        var taunts = { 
            3: ["😏 才3连击？", "🤭 慢慢来不急~", "😎 我都超你啦！"], 
            5: ["🔥 5连击！抖动了吗？", "⚡ 闪开！速度女王来了！", "🚀 五连！你追得上吗~"], 
            8: ["😤 8连击！跪下叫大佬！", "👑 8连！膜拜我吧！", "🎯 八连！心跳加速了吗~"], 
            10: ["💥 10连！你已经输了！", "🏆 双手奉上冠军宝座！", "🌟 10连击！传说诞生！"], 
            15: ["🐉 15连！我已无敌！", "👾 15连！跪着听我说！", "⚡ 十五连！神话降临！"] 
        };
        var tauntIcons = { 3:"😏", 5:"🔥", 8:"😤", 10:"💥", 15:"🐉" };
        
        function getTaunt(combo) {
            var keys = [15, 10, 8, 5, 3];
            for (var i = 0; i < keys.length; i++) {
                if (combo >= keys[i]) {
                    var arr = taunts[keys[i]];
                    var text = arr[Math.floor(Math.random() * arr.length)];
                    return { text: text, icon: tauntIcons[keys[i]] };
                }
            }
            return null;
        }

        // ==========================================
        // 商店与主题数据
        // ==========================================
        var shopCatalog = {
            avatars: [
                {id:'🦄', name:'独角兽', cost:200}, 
                {id:'🐼', name:'功夫熊猫', cost:300}, 
                {id:'🦖', name:'霸王龙', cost:500}, 
                {id:'👽', name:'外星来客', cost:800}, 
                {id:'🤖', name:'算力机甲', cost:1000}, 
                {id:'🧙‍♂️', name:'魔法老翁', cost:1500}, 
                {id:'🐈', name:'招财猫', cost:600}, 
                {id:'🦅', name:'傲世苍鹰', cost:1200}, 
                {id:'🦈', name:'深海狂鲨', cost:1400}, 
                {id:'🦸', name:'数学超人', cost:2000},
                {id:'🥷', name:'暗影忍者', cost:500, reqStreak: 7}, 
                {id:'🧛', name:'德古拉', cost:1000, reqStreak: 30}, 
                {id:'🧜', name:'深海人鱼', cost:2000, reqStreak: 90}, 
                {id:'🧚', name:'森林精灵', cost:5000, reqStreak: 150}, 
                {id:'👑', name:'速算大帝', cost:10000, reqStreak: 300}
            ],
            themes: [
                {id:'sakura', name:'樱花漫舞', cost:600, emoji:'🌸', bg:'bg-gradient-to-br from-pink-200 via-pink-50 to-rose-200'}, 
                {id:'forest', name:'绿野仙踪', cost:800, emoji:'🌲', bg:'bg-gradient-to-br from-green-200 via-green-50 to-emerald-200'}, 
                {id:'sunset', name:'落日余晖', cost:1000, emoji:'🌅', bg:'bg-gradient-to-br from-orange-200 via-orange-50 to-red-200'}, 
                {id:'night', name:'星空暗夜', cost:1500, emoji:'🌌', bg:'bg-gradient-to-br from-indigo-900 via-purple-900 to-slate-900'}, 
                {id:'beach', name:'夏日海滩', cost:1200, emoji:'🏖️', bg:'bg-gradient-to-br from-amber-200 via-yellow-50 to-cyan-300'}, 
                {id:'winter', name:'冰雪世界', cost:1200, emoji:'❄️', bg:'bg-gradient-to-br from-slate-100 via-white to-blue-200'}, 
                {id:'candy', name:'糖果乐园', cost:800, emoji:'🍬', bg:'bg-gradient-to-br from-purple-200 via-pink-100 to-yellow-100'}, 
                {id:'cyber', name:'赛博空间', cost:2000, emoji:'👾', bg:'bg-gradient-to-br from-slate-900 via-slate-800 to-emerald-900'},
                {id:'golden', name:'黄金时代', cost:800, emoji:'🪙', bg:'bg-gradient-to-br from-yellow-300 via-yellow-100 to-amber-200', reqStreak: 7}, 
                {id:'shadow', name:'暗影刺客', cost:1500, emoji:'🗡️', bg:'bg-gradient-to-br from-gray-800 via-gray-600 to-black', reqStreak: 30}, 
                {id:'deepsea', name:'深海幽灵', cost:3000, emoji:'🌊', bg:'bg-gradient-to-br from-blue-900 via-cyan-900 to-slate-900', reqStreak: 90}, 
                {id:'starTrek', name:'星际迷航', cost:6000, emoji:'🛸', bg:'bg-gradient-to-br from-indigo-900 via-purple-900 to-black', reqStreak: 150}, 
                {id:'legendary', name:'传奇殿堂', cost:12000, emoji:'🏰', bg:'bg-gradient-to-br from-yellow-500 via-red-500 to-purple-600', reqStreak: 300}
            ]
        };
        
        var themesConfig = { 
            'default': { bgStart:'#FFE8F4', bgMid:'#FFF5E4', bgEnd:'#E4F5FF', card1:'#FF6B8A', card2:'#FF9F43', card3:'#FFD700', primStart:'#FF9A9E', primEnd:'#FF6B8A', textMain:'#ec4899', borderMain:'#fbcfe8', bgLight:'#fdf2f8' },
            'sakura': { bgStart:'#fce7f3', bgMid:'#fdf2f8', bgEnd:'#fbcfe8', card1:'#f43f5e', card2:'#e11d48', card3:'#be123c', primStart:'#fb7185', primEnd:'#e11d48', textMain:'#e11d48', borderMain:'#fbcfe8', bgLight:'#fff1f2' },
            'forest': { bgStart:'#dcfce7', bgMid:'#ecfdf5', bgEnd:'#a7f3d0', card1:'#10b981', card2:'#059669', card3:'#047857', primStart:'#34d399', primEnd:'#059669', textMain:'#059669', borderMain:'#a7f3d0', bgLight:'#ecfdf5' },
            'sunset': { bgStart:'#ffedd5', bgMid:'#fff7ed', bgEnd:'#fde68a', card1:'#f97316', card2:'#ea580c', card3:'#c2410c', primStart:'#fb923c', primEnd:'#ea580c', textMain:'#ea580c', borderMain:'#fed7aa', bgLight:'#fff7ed' },
            'night': { bgStart:'#1e1b4b', bgMid:'#312e81', bgEnd:'#4c1d95', card1:'#4c1d95', card2:'#312e81', card3:'#1e1b4b', primStart:'#8b5cf6', primEnd:'#6d28d9', textMain:'#8b5cf6', borderMain:'#c7d2fe', bgLight:'#e0e7ff' },
            'beach': { bgStart:'#cffafe', bgMid:'#ecfeff', bgEnd:'#a5f3fc', card1:'#06b6d4', card2:'#0891b2', card3:'#0e7490', primStart:'#22d3ee', primEnd:'#0891b2', textMain:'#0891b2', borderMain:'#a5f3fc', bgLight:'#ecfeff' },
            'winter': { bgStart:'#e0f2fe', bgMid:'#f0f9ff', bgEnd:'#bae6fd', card1:'#0ea5e9', card2:'#0284c7', card3:'#0369a1', primStart:'#38bdf8', primEnd:'#0284c7', textMain:'#0284c7', borderMain:'#bae6fd', bgLight:'#f0f9ff' },
            'candy': { bgStart:'#f3e8ff', bgMid:'#faf5ff', bgEnd:'#e9d5ff', card1:'#a855f7', card2:'#9333ea', card3:'#7e22ce', primStart:'#c084fc', primEnd:'#9333ea', textMain:'#9333ea', borderMain:'#e9d5ff', bgLight:'#faf5ff' },
            'cyber': { bgStart:'#0f172a', bgMid:'#1e293b', bgEnd:'#334155', card1:'#334155', card2:'#1e293b', card3:'#0f172a', primStart:'#10b981', primEnd:'#059669', textMain:'#10b981', borderMain:'#334155', bgLight:'#f8fafc' },
            'golden': { bgStart:'#fef3c7', bgMid:'#fffbeb', bgEnd:'#fde68a', card1:'#eab308', card2:'#d97706', card3:'#b45309', primStart:'#facc15', primEnd:'#d97706', textMain:'#d97706', borderMain:'#fde68a', bgLight:'#fffbeb' },
            'shadow': { bgStart:'#f1f5f9', bgMid:'#f8fafc', bgEnd:'#e2e8f0', card1:'#475569', card2:'#334155', card3:'#1e293b', primStart:'#64748b', primEnd:'#475569', textMain:'#475569', borderMain:'#e2e8f0', bgLight:'#f8fafc' },
            'deepsea': { bgStart:'#ccfbf1', bgMid:'#cffafe', bgEnd:'#a5f3fc', card1:'#155e75', card2:'#164e63', card3:'#083344', primStart:'#06b6d4', primEnd:'#155e75', textMain:'#155e75', borderMain:'#a5f3fc', bgLight:'#ecfeff' },
            'starTrek': { bgStart:'#e0e7ff', bgMid:'#eef2ff', bgEnd:'#c7d2fe', card1:'#3730a3', card2:'#312e81', card3:'#1e1b4b', primStart:'#6366f1', primEnd:'#3730a3', textMain:'#3730a3', borderMain:'#c7d2fe', bgLight:'#eef2ff' },
            'legendary': { bgStart:'#ffedd5', bgMid:'#fff7ed', bgEnd:'#fde68a', card1:'#dc2626', card2:'#b91c1c', card3:'#991b1b', primStart:'#ef4444', primEnd:'#dc2626', textMain:'#dc2626', borderMain:'#fecaca', bgLight:'#fef2f2' }
        };

        // ==========================================
        // 出题引擎
        // ==========================================
        function rand(min, max) { 
            return Math.floor(Math.random() * (max - min + 1)) + min; 
        }
        
        var generators = {
            'add20': function(){ 
                var a = rand(1, 20);
                var b = rand(1, 20); 
                return { q: a + '+' + b, a: a + b }; 
            },
            'add100': function(){ 
                var a = rand(11, 99);
                var b = rand(11, 99); 
                return { q: a + '+' + b, a: a + b }; 
            },
            'mult9': function(){ 
                var a = rand(2, 9);
                var b = rand(2, 9); 
                return { q: a + '×' + b, a: a * b }; 
            },
            'div9': function(){ 
                var b = rand(2, 9);
                var ans = rand(2, 9); 
                return { q: (b * ans) + '÷' + b, a: ans }; 
            },
            'mult2': function(){ 
                var a = rand(11, 99);
                var b = rand(2, 9); 
                return { q: a + '×' + b, a: a * b }; 
            },
            'div2': function(){ 
                var b = rand(2, 9) * 10;
                var ans = rand(2, 12) * 10; 
                return { q: (b * ans) + '÷' + b, a: ans }; 
            },
            'round': function(){ 
                var base = rand(2, 9) * 100;
                var off = rand(1, 3) * (Math.random() > 0.5 ? 1 : -1);
                var a = base + off;
                var b = rand(11, 99); 
                return { q: a + '+' + b, a: a + b }; 
            },
            'mix1': function(){ 
                var a = rand(1, 9) * 10;
                var b = rand(1, 9) * 10;
                var c = rand(2, 5); 
                return { q: '(' + a + '+' + b + ')×' + c, a: (a + b) * c }; 
            },
            'mixSpeed': function(){ 
                var isAdd = Math.random() > 0.5; 
                var pairs = [[25, 4], [125, 8], [15, 4], [25, 8], [50, 2]];
                var p = pairs[rand(0, pairs.length - 1)]; 
                var a = p[0];
                var b = p[1]; 
                if (Math.random() > 0.5) {
                    var t = a; a = b; b = t;
                }
                var prod = a * b;
                var c = rand(10, 99); 
                if (!isAdd && prod <= c) { 
                    c = rand(1, Math.max(1, prod - 1)); 
                }
                return isAdd ? { q: a + ' × ' + b + ' + ' + c, a: prod + c } : { q: a + ' × ' + b + ' - ' + c, a: prod - c };
            },
            'decAddSub': function(){ 
                var a = rand(11, 99) / 10;
                var b = rand(11, 99) / 10; 
                return { q: a.toFixed(1) + '+' + b.toFixed(1), a: Math.round((a + b) * 10) / 10 }; 
            },
            'decMultDiv': function(){ 
                var a = rand(11, 99) / 10;
                var b = rand(2, 9); 
                return { q: a.toFixed(1) + '×' + b, a: Math.round(a * b * 10) / 10 }; 
            },
            'mix2': function(){ 
                var isAdd = Math.random() > 0.5;
                var a = rand(2, 9);
                var b = rand(2, 9);
                var prod = a * b;
                var c = rand(11, 99);
                if (!isAdd && prod <= c) { 
                    return { q: c + ' + ' + a + '×' + b, a: c + prod }; 
                }
                return isAdd ? { q: a + '×' + b + ' + ' + c, a: prod + c } : { q: a + '×' + b + ' - ' + c, a: prod - c };
            }
        };

        var gradeTopicsData = {
            'g12': [{id:'add20',name:'20以内加减'}, {id:'add100',name:'100以内加减'}, {id:'mult9',name:'九九乘法表'}, {id:'div9',name:'表内除法'}],
            'g34': [{id:'mult2',name:'多位数乘法'}, {id:'div2',name:'多位数除法'}, {id:'round',name:'灵活凑整'}, {id:'mix1',name:'基础混合'}, {id:'mixSpeed',name:'混合速算'}],
            'g56': [{id:'decAddSub',name:'小数加减'}, {id:'decMultDiv',name:'小数乘除'}, {id:'mix2',name:'进阶混合'}]
        };

        function generateQuestions(grade, types, count) {
            var questions = [];
            var loops = 0;
            while (questions.length < count && loops < 500) {
                var t = types[Math.floor(Math.random() * types.length)];
                var q = generators[t]();
                var exist = false;
                for (var i = 0; i < questions.length; i++) {
                    if (questions[i].q === q.q) {
                        exist = true;
                        break;
                    }
                }
                if (!exist) questions.push(q);
                loops++;
            }
            return questions;
        }

        // ==========================================
        // 核心页面及 UI 渲染控制
        // ==========================================
        var allScreens = ['screen-login', 'screen-setup', 'screen-play', 'screen-result', 'screen-battle-lobby', 'screen-battle-room', 'screen-battle-play', 'screen-battle-result'];
        
        function showScreen(id) {
            for (var i = 0; i < allScreens.length; i++) {
                var el = document.getElementById(allScreens[i]);
                if (el) {
                    el.classList.add('hidden');
                    el.classList.remove('flex');
                }
            }
            var target = document.getElementById(id);
            if (target) {
                target.classList.remove('hidden');
                target.classList.add('flex');
            }
            if (id === 'screen-setup') updateUI();
        }

        function safeSet(id, val) {
            var el = document.getElementById(id);
            if (el) el.innerHTML = val;
        }
        
        function applyTheme(themeId) {
            var config = themesConfig[themeId] || themesConfig['default'];
            var root = document.documentElement;
            root.style.setProperty('--bg-start', config.bgStart);
            root.style.setProperty('--bg-mid', config.bgMid);
            root.style.setProperty('--bg-end', config.bgEnd);
            root.style.setProperty('--card-grad-1', config.card1);
            root.style.setProperty('--card-grad-2', config.card2);
            root.style.setProperty('--card-grad-3', config.card3);
            root.style.setProperty('--primary-start', config.primStart);
            root.style.setProperty('--primary-end', config.primEnd);
            root.style.setProperty('--text-main', config.textMain);
            root.style.setProperty('--border-main', config.borderMain);
            root.style.setProperty('--bg-light', config.bgLight);
        }

        function updateUI() {
            safeSet('display-name', user.name); 
            safeSet('display-lv', 'LV.' + user.level); 
            safeSet('display-coins', user.coins);
            safeSet('shop-coin-display', user.coins); 
            safeSet('display-streak', user.streak);
            
            var currentLevelStart = (user.level - 1) * (user.level - 1) * 30;
            var nextLevelExp = user.level * user.level * 30;
            var progress = ((user.exp - currentLevelStart) / (nextLevelExp - currentLevelStart)) * 100;
            
            var expBar = document.getElementById('exp-bar');
            if (expBar) expBar.style.width = Math.min(progress, 100) + '%';
            
            safeSet('display-exp-text', user.exp + ' / ' + nextLevelExp + ' EXP');
            safeSet('mistake-count', user.mistakes.length);
            
            var ranks = ["算术学徒", "口算小兵", "速算游侠", "心算大师", "数字统领", "算力超神"];
            var rankIndex = Math.min(Math.floor((user.level - 1) / 5), ranks.length - 1);
            safeSet('display-rank', ranks[rankIndex]);
            
            safeSet('avatar-emoji', user.currentAvatar);
            safeSet('player-bear', user.currentAvatar);
            safeSet('ghost-bear', user.currentAvatar);
            
            applyTheme(user.currentTheme || 'default');
            
            var modeTabs = document.querySelectorAll('.mode-tab');
            for (var i = 0; i < modeTabs.length; i++) {
                var t = modeTabs[i];
                if(t.classList.contains('active')) {
                    t.style.cssText = 'background:var(--bg-light);color:var(--text-main);border:2px solid var(--primary-start);box-shadow:0 4px 0 var(--primary-start)';
                } else {
                    t.style.cssText = 'background:#F3F4F6;color:#9CA3AF;border:none;box-shadow:0 4px 0 #D1D5DB';
                }
            }
        }

        function openModal(id) { 
            document.getElementById('modal-container').classList.remove('hidden'); 
            document.getElementById(id).classList.remove('hidden'); 
            document.getElementById(id).classList.add('flex'); 
        }
        
        function closeAllModals() { 
            document.getElementById('modal-container').classList.add('hidden'); 
            var modals = ['modal-shop', 'modal-wardrobe', 'modal-levelup', 'modal-leaderboard'];
            for (var i = 0; i < modals.length; i++) {
                var el = document.getElementById(modals[i]); 
                if(el) { 
                    el.classList.add('hidden'); 
                    el.classList.remove('flex'); 
                }
            } 
        }

        // ==========================================
        // 绑定各种 DOM 事件
        // ==========================================
        
        var btnCloseModals = document.querySelectorAll('.btn-close-modal');
        for (var i = 0; i < btnCloseModals.length; i++) {
            btnCloseModals[i].onclick = closeAllModals;
        }
        document.getElementById('modal-backdrop').onclick = closeAllModals;

        // 登录系统
        document.getElementById('btn-login').onclick = async function(e) {
            var name = document.getElementById('input-nickname').value.trim();
            if (!name) { 
                customAlert('请输入英雄代号！'); 
                return; 
            }
            var btn = e.currentTarget; 
            var originalText = btn.innerHTML;
            btn.innerHTML = '连接云端... ⏳'; 
            btn.disabled = true;
            try { 
                var data = await apiFetch('/api/get-user?name=' + encodeURIComponent(name));
                user = data; 
                user.name = name; 
                updateUI(); 
                showScreen('screen-setup'); 
            } catch (err) { 
                console.error(err);
            } finally { 
                btn.innerHTML = originalText; 
                btn.disabled = false; 
            }
        };
        
        document.getElementById('input-nickname').onkeydown = function(e) { 
            if (e.key === 'Enter') document.getElementById('btn-login').click(); 
        };
        
        document.getElementById('btn-signin').onclick = async function() { 
            try {
                var data = await apiFetch('/api/get-user?name=' + encodeURIComponent(user.name));
                var curName = user.name;
                user = data;
                user.name = curName;
                updateUI();
            } catch(e) {}
            customAlert("🔥 每日坚持签到大放送！<br><br>累积登录 7、30、90、150、300天，能在商店解锁传说级绝版皮肤！<br><br>你当前已连续登录：" + user.streak + " 天，继续保持！"); 
        };

        // 多人游戏大厅选项卡切换逻辑
        function setLobbyTab(tabName) {
            var btnCreate = document.getElementById('btn-create-room');
            var btnJoin = document.getElementById('btn-join-room');
            var configArea = document.getElementById('battle-config');
            var confirmBtn = document.getElementById('btn-create-confirm');
            var inputArea = document.getElementById('join-room-input');
            
            if (tabName === 'create') {
                btnCreate.className = "btn-cute btn-purple-custom p-4 rounded-2xl font-black text-white flex flex-col items-center gap-2";
                btnCreate.style.boxShadow = "0 5px 0 #7C3AED";
                btnJoin.className = "btn-cute p-4 rounded-2xl font-black flex flex-col items-center gap-2 bg-gray-100 text-gray-400 shadow-none";
                
                if (configArea) configArea.classList.remove('hidden');
                if (confirmBtn) confirmBtn.classList.remove('hidden');
                if (inputArea) inputArea.classList.add('hidden');
            } else {
                btnJoin.className = "btn-cute btn-purple-custom p-4 rounded-2xl font-black text-white flex flex-col items-center gap-2";
                btnJoin.style.boxShadow = "0 5px 0 #7C3AED";
                btnCreate.className = "btn-cute p-4 rounded-2xl font-black flex flex-col items-center gap-2 bg-gray-100 text-gray-400 shadow-none";
                
                if (inputArea) inputArea.classList.remove('hidden');
                if (configArea) configArea.classList.add('hidden');
                if (confirmBtn) confirmBtn.classList.add('hidden');
            }
        }

        document.getElementById('btn-open-battle').onclick = function() { 
            showScreen('screen-battle-lobby'); 
            renderTopics('g34', 'battle-type-checkboxes', 'battle'); 
            setLobbyTab('create'); 
        };
        
        document.getElementById('btn-battle-back').onclick = function() { 
            showScreen('screen-setup'); 
        };
        
        document.getElementById('btn-create-room').onclick = function() { 
            setLobbyTab('create');
        };
        
        document.getElementById('btn-join-room').onclick = function() { 
            setLobbyTab('join');
        };

        // 模式切换
        var modeTabs = document.querySelectorAll('.mode-tab');
        for (var m = 0; m < modeTabs.length; m++) {
            modeTabs[m].onclick = function(e) {
                var tabs = document.querySelectorAll('.mode-tab');
                for (var j = 0; j < tabs.length; j++) {
                    tabs[j].style.cssText = 'background:#F3F4F6;color:#9CA3AF;border:none;box-shadow:0 4px 0 #D1D5DB';
                    tabs[j].classList.remove('active');
                }
                var activeTab = e.currentTarget;
                activeTab.classList.add('active');
                activeTab.style.cssText = 'background:var(--bg-light);color:var(--text-main);border:2px solid var(--primary-start);box-shadow:0 4px 0 var(--primary-start)';
                game.mode = activeTab.getAttribute('data-mode');
                
                if (game.mode === 'mistake') {
                    document.getElementById('normal-config').classList.add('hidden');
                    document.getElementById('mistake-config').classList.remove('hidden');
                } else {
                    document.getElementById('normal-config').classList.remove('hidden');
                    document.getElementById('mistake-config').classList.add('hidden');
                }
            };
        }

        // 题型渲染
        function renderTopics(gradeKey, containerId, prefix) {
            var topics = gradeTopicsData[gradeKey]; 
            containerId = containerId || 'type-checkboxes'; 
            prefix = prefix || ''; 
            var html = '';
            for (var i = 0; i < topics.length; i++) {
                var t = topics[i];
                html += '<label class="flex items-center p-2 border-2 rounded-xl cursor-pointer border-gray-100 bg-white shadow-sm gap-2 transition-all">';
                var inputName = prefix ? 'name="battleType"' : '';
                html += '<input type="checkbox" value="' + t.id + '" class="w-4 h-4 flex-shrink-0" style="accent-color: var(--primary-start)" ' + inputName + ' checked>';
                html += '<span class="font-bold text-gray-600 text-xs">' + t.name + '</span></label>';
            }
            document.getElementById(containerId).innerHTML = html;
        }

        var gradeInputs = document.querySelectorAll('input[name="grade"]');
        for (var g = 0; g < gradeInputs.length; g++) {
            gradeInputs[g].onchange = function(e) { renderTopics(e.target.value); };
        }
        renderTopics('g34');

        var battleGradeInputs = document.querySelectorAll('input[name="battleGrade"]');
        for (var bg = 0; bg < battleGradeInputs.length; bg++) {
            battleGradeInputs[bg].onchange = function(e) { renderTopics(e.target.value, 'battle-type-checkboxes', 'battle'); };
        }

        // 排行榜功能
        document.getElementById('btn-open-leaderboard').onclick = async function() {
            openModal('modal-leaderboard'); 
            var container = document.getElementById('leaderboard-items-container');
            container.innerHTML = '<div class="p-8 text-center text-gray-400 font-bold animate-pulse">📡 连接中...</div>';
            try {
                var list = await apiFetch('/api/leaderboard'); 
                var html = '';
                for (var i = 0; i < list.length; i++) {
                    var p = list[i];
                    var rankIcon = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1);
                    var isMe = p.name === user.name ? 'bg-theme-light border-l-4 border-theme-main' : 'border-b border-gray-50';
                    html += '<div class="flex items-center p-3 ' + isMe + '">';
                    var rankClass = i < 3 ? 'text-2xl' : 'text-base text-gray-400';
                    html += '<div class="w-10 text-center font-black mr-2 ' + rankClass + '">' + rankIcon + '</div>';
                    html += '<div class="text-3xl mr-3">' + p.avatar + '</div>';
                    html += '<div class="flex-grow min-w-0"><div class="font-black text-gray-700 truncate text-sm">' + p.name + '</div><div class="text-[10px] text-gray-400 font-bold">LV.' + p.level + '</div></div>';
                    html += '<div class="text-right"><div class="font-black text-theme-main">' + p.exp + '</div><div class="text-[10px] text-gray-400">EXP</div></div></div>';
                }
                if (!list.length) {
                    html = '<div class="p-8 text-center text-gray-400 font-bold">还没有英雄！去战斗吧！</div>';
                }
                container.innerHTML = html;
            } catch(e) { 
                container.innerHTML = '<div class="p-8 text-center text-red-400 font-bold">读取失败 😭</div>'; 
            }
        };

        // ==========================================
        // 商店与衣橱功能 (安全绑定)
        // ==========================================
        window.handleBuyClick = async function(e) {
            var btn = e.currentTarget;
            var id = btn.dataset.id;
            var cost = parseInt(btn.dataset.cost);
            var type = btn.dataset.type;
            var reqStreak = parseInt(btn.dataset.reqstreak);
            
            if (user.streak < reqStreak) { 
                customAlert('需要连续登录 ' + reqStreak + ' 天才能解锁此物品哦！'); 
                return; 
            }
            if (user.coins < cost) { 
                customAlert('金币不够！多做几道题赚金币吧~ 🪙'); 
                return; 
            }
            if (confirm('确定花费 ' + cost + ' 金币购买吗？')) {
                try { 
                    var res = await apiFetch('/api/action', { 
                        method: 'POST', 
                        headers: {'Content-Type':'application/json'}, 
                        body: JSON.stringify({ name: user.name, action: 'buy', payload: { type: type, id: id, cost: cost } }) 
                    }); 
                    var curName = user.name;
                    user = res.user; 
                    user.name = curName;
                    updateUI(); 
                    window.renderShop(); 
                } catch(err) {}
            }
        };

        window.renderShop = function() {
            var container = document.getElementById('shop-items-container');
            
            var unpurchasedAvatars = [];
            for (var a = 0; a < shopCatalog.avatars.length; a++) {
                if (!user.unlockedAvatars.includes(shopCatalog.avatars[a].id)) {
                    unpurchasedAvatars.push(shopCatalog.avatars[a]);
                }
            }
            
            var unpurchasedThemes = [];
            var ut = user.unlockedThemes || ['default'];
            for (var t = 0; t < shopCatalog.themes.length; t++) {
                if (!ut.includes(shopCatalog.themes[t].id)) {
                    unpurchasedThemes.push(shopCatalog.themes[t]);
                }
            }

            if (unpurchasedAvatars.length === 0 && unpurchasedThemes.length === 0) {
                container.innerHTML = '<div class="text-center py-10"><div class="text-5xl mb-2">🎉</div><div class="font-black text-gray-400">太强了！<br>商店已经被你买空啦！</div></div>';
                return;
            }

            var html = '';
            if (unpurchasedAvatars.length > 0) {
                html += '<div><div class="text-sm font-black text-gray-400 mb-3">🎭 限量头像</div><div class="grid grid-cols-2 gap-3">';
                for (var i = 0; i < unpurchasedAvatars.length; i++) {
                    var item = unpurchasedAvatars[i];
                    var reqStreak = item.reqStreak || 0;
                    var lockedByStreak = user.streak < reqStreak;
                    var canAfford = user.coins >= item.cost && !lockedByStreak;
                    
                    html += '<div class="bg-gray-50 border-2 border-yellow-100 rounded-2xl p-3 flex flex-col items-center text-center">';
                    html += '<div class="text-4xl mb-1">' + item.id + '</div>';
                    html += '<div class="text-xs font-bold text-gray-500 mb-2">' + item.name + '</div>';
                    
                    if (lockedByStreak) {
                        html += '<button class="w-full bg-gray-300 text-gray-500 font-bold py-1.5 rounded-xl text-[10px]" disabled>连登 ' + reqStreak + ' 天解锁</button>';
                    } else {
                        var bc = canAfford ? 'btn-cute btn-warning buy-btn' : 'bg-gray-200 text-gray-400 cursor-not-allowed rounded-xl';
                        // 使用 dataset，绝对不使用 onclick
                        html += '<button class="w-full ' + bc + '" data-id="' + item.id + '" data-cost="' + item.cost + '" data-type="avatar" data-reqstreak="' + reqStreak + '">🪙 ' + item.cost + '</button>';
                    }
                    html += '</div>';
                }
                html += '</div></div>';
            }

            if (unpurchasedThemes.length > 0) {
                html += '<div class="mt-4"><div class="text-sm font-black text-gray-400 mb-3">🎨 传说皮肤</div><div class="grid grid-cols-2 gap-3">';
                for (var j = 0; j < unpurchasedThemes.length; j++) {
                    var itemTheme = unpurchasedThemes[j];
                    var reqStreakTheme = itemTheme.reqStreak || 0;
                    var lockedTheme = user.streak < reqStreakTheme;
                    var canAffordTheme = user.coins >= itemTheme.cost && !lockedTheme;
                    
                    html += '<div class="border-2 border-yellow-100 rounded-2xl p-3 flex flex-col items-center text-center relative overflow-hidden">';
                    html += '<div class="absolute inset-0 opacity-25 ' + itemTheme.bg + '"></div>';
                    html += '<div class="text-4xl mb-1 relative z-10">' + itemTheme.emoji + '</div>';
                    html += '<div class="text-xs font-bold text-gray-500 mb-2 relative z-10">' + itemTheme.name + '</div>';
                    
                    if (lockedTheme) {
                        html += '<button class="w-full bg-gray-300 text-gray-500 font-bold py-1.5 rounded-xl text-[10px] relative z-10" disabled>连登 ' + reqStreakTheme + ' 天解锁</button>';
                    } else {
                        var btnC = canAffordTheme ? 'btn-cute btn-warning buy-btn' : 'bg-gray-200 text-gray-400 cursor-not-allowed rounded-xl';
                        // 使用 dataset，绝对不使用 onclick
                        html += '<button class="w-full ' + btnC + ' relative z-10" data-id="' + itemTheme.id + '" data-cost="' + itemTheme.cost + '" data-type="theme" data-reqstreak="' + reqStreakTheme + '">🪙 ' + itemTheme.cost + '</button>';
                    }
                    html += '</div>';
                }
                html += '</div></div>';
            }
            container.innerHTML = html;
            
            // 循环绑定事件，绝不拼接字符串
            var buyBtns = document.querySelectorAll('.buy-btn');
            for (var b = 0; b < buyBtns.length; b++) {
                buyBtns[b].onclick = window.handleBuyClick;
            }
        };

        document.getElementById('btn-open-shop').onclick = function() { 
            window.renderShop(); 
            openModal('modal-shop'); 
        };

        window.handleEquipClick = async function(e) {
            var btn = e.currentTarget;
            var id = btn.dataset.id;
            var type = btn.dataset.type;
            try { 
                var res = await apiFetch('/api/action', { 
                    method: 'POST', 
                    headers: {'Content-Type':'application/json'}, 
                    body: JSON.stringify({ name: user.name, action: 'equip', payload: { type: type, id: id } }) 
                }); 
                var curName = user.name;
                user = res.user; 
                user.name = curName;
                updateUI(); 
                window.renderWardrobe(); 
            } catch(err) { } 
        };

        window.renderWardrobe = function() {
            var container = document.getElementById('wardrobe-items-container');
            var html = '<div><div class="text-sm font-black text-gray-400 mb-3">🎭 我的头像</div><div class="grid grid-cols-3 gap-3">';
            
            for (var i = 0; i < user.unlockedAvatars.length; i++) {
                var id = user.unlockedAvatars[i];
                var isCurrent = user.currentAvatar === id;
                var bClass = isCurrent ? 'border-[var(--primary-start)] bg-[var(--bg-light)]' : 'border-gray-200 hover:bg-gray-50';
                
                // 彻底去掉 onclick，改用 dataset
                html += '<div class="border-3 ' + bClass + ' rounded-2xl p-3 flex flex-col items-center cursor-pointer equip-btn" style="border-width:3px" data-id="' + id + '" data-type="avatar">';
                html += '<div class="text-4xl">' + id + '</div>';
                if (isCurrent) {
                    html += '<div class="text-[10px] font-black text-theme-main mt-1">佩戴中</div>';
                }
                html += '</div>';
            }
            html += '</div></div><div><div class="text-sm font-black text-gray-400 mb-3 mt-4">🎨 我的皮肤</div><div class="grid grid-cols-3 gap-2">';
            
            var unlockedThemes = user.unlockedThemes || ['default']; 
            if (!unlockedThemes.includes('default')) unlockedThemes.unshift('default');
            
            for (var j = 0; j < unlockedThemes.length; j++) {
                var tid = unlockedThemes[j];
                var isCurTheme = (user.currentTheme || 'default') === tid;
                
                var themeObj = null;
                for (var k = 0; k < shopCatalog.themes.length; k++) {
                    if (shopCatalog.themes[k].id === tid) themeObj = shopCatalog.themes[k];
                }
                
                var emoji = tid === 'default' ? '☁️' : (themeObj ? themeObj.emoji : '🎨');
                var tName = tid === 'default' ? '经典' : (themeObj ? themeObj.name : '皮肤');
                var bg = tid === 'default' ? 'bg-blue-100' : (themeObj ? themeObj.bg : 'bg-gray-100');
                
                var tbClass = isCurTheme ? 'border-[var(--primary-start)]' : 'border-gray-200';
                
                // 彻底去掉 onclick，改用 dataset
                html += '<div class="border-3 ' + tbClass + ' rounded-2xl p-2 flex flex-col items-center cursor-pointer relative overflow-hidden equip-btn" style="border-width:3px" data-id="' + tid + '" data-type="theme">';
                html += '<div class="absolute inset-0 opacity-40 ' + bg + '"></div>';
                html += '<div class="text-3xl relative z-10">' + emoji + '</div>';
                html += '<div class="text-[10px] font-bold text-gray-600 relative z-10 mt-1">' + tName + '</div>';
                if (isCurTheme) {
                    html += '<div class="text-[9px] font-black text-theme-main relative z-10 bg-white/80 px-1 rounded mt-1">使用中</div>';
                }
                html += '</div>';
            }
            html += '</div></div>';
            container.innerHTML = html;
            
            // 绑定装备事件
            var equipBtns = document.querySelectorAll('.equip-btn');
            for (var e = 0; e < equipBtns.length; e++) {
                equipBtns[e].onclick = window.handleEquipClick;
            }
        };

        document.getElementById('btn-open-wardrobe').onclick = function() { 
            window.renderWardrobe(); 
            openModal('modal-wardrobe'); 
        };

        // ==========================================
        // 单人练习核心逻辑
        // ==========================================
        document.getElementById('btn-start').onclick = function() {
            var countElement = document.querySelector('input[name="count"]:checked');
            var count = parseInt(countElement.value);
            game.questions = []; 
            game.currentIndex = 0; 
            game.mistakes = []; 
            game.correctOnes = []; 
            game.combo = 0; 
            var configKey = "";
            
            if (game.mode === 'mistake') {
                if (!user.mistakes || user.mistakes.length === 0) { 
                    customAlert('暂无错题！先去普通模式练习吧 💪'); 
                    return; 
                }
                var pool = user.mistakes.slice().sort(function(a,b){ return b.count - a.count; });
                for (var i = 0; i < count; i++) {
                    game.questions.push(pool[i % pool.length]);
                }
                configKey = "mistake_mode"; 
                game.grade = 'mistake'; 
                game.types = [];
            } else {
                var checkedTypes = document.querySelectorAll('#type-checkboxes input:checked');
                if (checkedTypes.length === 0) { 
                    customAlert('请至少选择一种题型！'); 
                    return; 
                }
                var types = []; 
                for (var j = 0; j < checkedTypes.length; j++) {
                    types.push(checkedTypes[j].value);
                }
                var grade = document.querySelector('input[name="grade"]:checked').value;
                configKey = grade + "_" + types.join('') + "_" + count; 
                game.grade = grade; 
                game.types = types; 
                game.questions = generateQuestions(grade, types, count);
            }
            
            game.hasPb = !!user.pbs[configKey]; 
            game.pbTime = user.pbs[configKey] || (count * 9); 
            game.configKey = configKey;
            
            showScreen('screen-play'); 
            startPlay();
        };

        function startPlay() { 
            game.startTime = Date.now(); 
            updateTimer(); 
            clearInterval(game.timer); 
            game.timer = setInterval(updateTimer, 100); 
            renderQuestion(); 
        }

        function updateTimer() {
            var elapsed = (Date.now() - game.startTime) / 1000; 
            document.getElementById('timer-text').innerText = elapsed.toFixed(1) + 's';
            
            var playerPos = (game.currentIndex / game.questions.length) * 88;
            document.getElementById('player-bear').style.left = playerPos + '%';
            
            var ghost = document.getElementById('ghost-bear'); 
            ghost.classList.remove('hidden');
            if (game.hasPb) { 
                ghost.innerText = user.currentAvatar; 
                ghost.style.opacity = "0.35"; 
                ghost.style.filter = "grayscale(80%)"; 
            } else { 
                ghost.innerText = '🤖'; 
                ghost.style.opacity = "0.6"; 
                ghost.style.filter = "none"; 
            }
            var ghostPos = Math.min((elapsed / game.pbTime) * 88, 92);
            ghost.style.left = ghostPos + '%';
        }

        function renderQuestion() {
            var q = game.questions[game.currentIndex]; 
            document.getElementById('question-text').innerHTML = q.q + ' <span class="animate-bounce text-theme-main text-4xl">=</span>'; 
            document.getElementById('progress-text').innerText = '第 ' + (game.currentIndex + 1) + ' / ' + game.questions.length + ' 题';
            
            game.currentInput = ""; 
            game.isProcessing = false; 
            
            var d = document.getElementById('answer-display'); 
            d.style.borderColor = 'var(--border-main)'; 
            d.style.boxShadow = '0 4px 0 var(--border-main), inset 0 2px 8px rgba(0,0,0,0.04)'; 
            d.style.background = 'white'; 
            document.getElementById('answer-value').style.color = 'var(--text-main)'; 
            updateAnswerUI();
        }

        function updateAnswerUI() { 
            var el = document.getElementById('answer-value'); 
            if (!game.currentInput) { 
                el.innerHTML = '<span style="color:#CBD5E1">输入答案</span>'; 
                el.classList.add('animate-pulse'); 
            } else { 
                el.innerText = game.currentInput; 
                el.classList.remove('animate-pulse'); 
            } 
        }
        
        window.handleInput = function(v) {
            if (game.isProcessing) return; 
            if (v === 'del') {
                game.currentInput = game.currentInput.slice(0, -1); 
            } else if (v === 'enter') {
                checkAnswer(); 
            } else if (game.currentInput.length < 8) { 
                if (v === '.' && game.currentInput.indexOf('.') !== -1) return; 
                game.currentInput += v; 
            } 
            updateAnswerUI();
        };

        function checkAnswer() {
            if (!game.currentInput || game.isProcessing) return; 
            game.isProcessing = true;
            
            var q = game.questions[game.currentIndex]; 
            var isCorrect = parseFloat(game.currentInput) === q.a; 
            var display = document.getElementById('answer-display'); 
            var comboNode = document.getElementById('combo-display');

            if (isCorrect) {
                game.combo++; 
                game.correctOnes.push(q.q);
                display.style.background = '#F0FFF4'; 
                display.style.borderColor = '#34D399'; 
                display.style.boxShadow = '0 4px 0 #34D399'; 
                document.getElementById('answer-value').style.color = '#059669';
                
                if (game.combo >= 3) {
                    var lvl = game.combo >= 10 ? 3 : game.combo >= 5 ? 2 : 1; 
                    var sizes = ['text-3xl', 'text-4xl', 'text-5xl']; 
                    comboNode.className = 'absolute top-28 right-3 font-black text-orange-500 pointer-events-none z-20 animate-pop ' + sizes[lvl-1]; 
                    var emojiStr = lvl === 3 ? '💥' : lvl === 2 ? '🔥' : '⚡';
                    comboNode.innerText = game.combo + '连击! ' + emojiStr;
                }
                setTimeout(nextQuestion, 280);
            } else {
                game.combo = 0; 
                game.mistakes.push({ q: q.q, correctAns: q.a, myAns: game.currentInput });
                display.style.background = '#FFF5F5'; 
                display.style.borderColor = '#F87171'; 
                display.style.boxShadow = '0 4px 0 #F87171'; 
                document.getElementById('answer-value').style.color = '#EF4444'; 
                display.classList.add('shake');
                setTimeout(function() { 
                    display.classList.remove('shake'); 
                    nextQuestion(); 
                }, 600);
            }
        }

        function nextQuestion() { 
            game.currentIndex++; 
            if (game.currentIndex >= game.questions.length) {
                finishGame(); 
            } else {
                renderQuestion(); 
            }
        }

        async function finishGame() {
            clearInterval(game.timer); 
            var totalTime = (Date.now() - game.startTime) / 1000;
            var correctCount = game.questions.length - game.mistakes.length;
            var accuracy = Math.round((correctCount / game.questions.length) * 100);
            
            try {
                var rd = await saveResult(accuracy, totalTime, game.mistakes, game.correctOnes, game.configKey, game.grade, game.types);
                
                // 同步服务端最新数据到本地
                if (rd.user) {
                    var curName = user.name;
                    user = rd.user;
                    user.name = curName;
                    updateUI();
                }
                
                safeSet('final-time', totalTime.toFixed(1) + 's'); 
                safeSet('final-acc', accuracy + '%'); 
                safeSet('final-exp', '+' + rd.exp + ' EXP'); 
                safeSet('final-coins', '+' + rd.coins);
                
                var isNewPb = accuracy === 100 && (!game.pbTime || totalTime < game.pbTime); 
                var pbTag = document.getElementById('pb-tag');
                if (isNewPb) {
                    pbTag.classList.remove('hidden');
                } else {
                    pbTag.classList.add('hidden');
                }
                
                var badge = accuracy === 100 ? '🏆' : accuracy >= 80 ? '🥈' : accuracy >= 60 ? '🥉' : '😅';
                var msg = accuracy === 100 ? '满分！太厉害了！' : accuracy >= 80 ? '真棒！继续加油！' : accuracy >= 60 ? '不错！还可以更好！' : '继续努力！加油！';
                
                safeSet('result-badge', badge); 
                safeSet('result-msg', msg); 
                showScreen('screen-result');

                if (rd.leveledUp) { 
                    setTimeout(function() { 
                        safeSet('levelup-number', 'LV.' + rd.newLevel); 
                        var uD = document.getElementById('levelup-unlocks'); 
                        var uI = document.getElementById('levelup-unlock-items'); 
                        if (rd.newUnlocks && rd.newUnlocks.length > 0) { 
                            var unlockHtml = '';
                            for (var k = 0; k < rd.newUnlocks.length; k++) {
                                unlockHtml += '<div class="bg-gray-100 rounded-xl p-2 text-3xl">' + rd.newUnlocks[k] + '</div>';
                            }
                            uI.innerHTML = unlockHtml;
                            uD.classList.remove('hidden'); 
                        } else { 
                            uD.classList.add('hidden'); 
                        } 
                        openModal('modal-levelup'); 
                    }, 800); 
                }
            } catch(e) { 
                customAlert("成绩保存失败：<br>" + e.message);
                console.error(e);
            }
        }

        document.getElementById('btn-restart').onclick = function() { 
            showScreen('screen-setup'); 
        };
        
        var singleKeypadBtns = document.querySelectorAll('.single-keypad-btn');
        for (var idx = 0; idx < singleKeypadBtns.length; idx++) {
            singleKeypadBtns[idx].onpointerdown = function(e) { 
                e.preventDefault(); 
                handleInput(e.currentTarget.getAttribute('data-val')); 
            };
        }

        // ==========================================
        // 多人游戏大厅逻辑
        // ==========================================
        
        document.getElementById('btn-create-confirm').onclick = async function() {
            var gradeRadio = document.querySelector('input[name="battleGrade"]:checked');
            var grade = gradeRadio ? gradeRadio.value : 'g34';
            
            var chk = document.querySelectorAll('#battle-type-checkboxes input:checked');
            if (chk.length === 0) { 
                customAlert('请选择至少一种题型！'); 
                return; 
            } 
            var types = [];
            for (var i = 0; i < chk.length; i++) {
                types.push(chk[i].value);
            }
            
            var countRadio = document.querySelector('input[name="battleCount"]:checked');
            var count = countRadio ? parseInt(countRadio.value) : 10;
            
            var code = Math.floor(1000 + Math.random() * 9000).toString(); 
            battle.roomCode = code; 
            battle.isHost = true; 
            battle.grade = grade; 
            battle.types = types; 
            battle.count = count;
            
            try { 
                var reqBody = { 
                    action: 'create',
                    name: user.name, 
                    avatar: user.currentAvatar, 
                    roomCode: code, 
                    grade: grade, 
                    types: types, 
                    count: count 
                };
                var d = await apiFetch('/api/battle/join', { 
                    method: 'POST', 
                    headers: {'Content-Type':'application/json'}, 
                    body: JSON.stringify(reqBody) 
                }); 
                showBattleRoom(d.room); 
            } catch(e) { }
        };

        document.getElementById('btn-confirm-join').onclick = async function() {
            var codeInput = document.getElementById('input-room-code');
            var code = codeInput.value.trim().toUpperCase(); 
            if (code.length !== 4) { 
                customAlert('请输入正确的4位数字房间码！'); 
                return; 
            }
            
            try { 
                var reqBody = { 
                    action: 'join',
                    name: user.name, 
                    avatar: user.currentAvatar, 
                    roomCode: code, 
                    grade: 'g34', 
                    types: [], 
                    count: 10 
                };
                var d = await apiFetch('/api/battle/join', { 
                    method: 'POST', 
                    headers: {'Content-Type':'application/json'}, 
                    body: JSON.stringify(reqBody) 
                }); 
                battle.roomCode = code; 
                battle.isHost = false; 
                showBattleRoom(d.room); 
            } catch(e) { }
        };

        function showBattleRoom(room) {
            showScreen('screen-battle-room'); 
            safeSet('display-room-code', room.code); 
            updateRoomPlayers(room);
            
            var sBtn = document.getElementById('btn-start-battle');
            var rBtn = document.getElementById('btn-ready-battle');
            var wMsg = document.getElementById('waiting-msg');
            
            // 显示房间配置信息
            var cfgSection = document.getElementById('room-config-section');
            var editBtn = document.getElementById('btn-edit-room-config');
            cfgSection.classList.remove('hidden');
            var gradeNames = { g12: '一二年级', g34: '三四年级', g56: '五六年级' };
            var typeNames = { add20:'20以内加减', add100:'100以内加减', mult9:'九九乘法表', div9:'表内除法', mult2:'多位数乘法', div2:'多位数除法', round:'灵活凑整', mix1:'基础混合', mixSpeed:'混合速算', decAddSub:'小数加减', decMultDiv:'小数乘除', mix2:'进阶混合' };
            if (room.config) {
                safeSet('room-config-grade', gradeNames[room.config.grade] || '三四年级');
                var tNames = (room.config.types || []).map(function(t) { return typeNames[t] || t; });
                safeSet('room-config-types', tNames.length > 0 ? tNames.join('、') : '全部');
                safeSet('room-config-count', (room.config.count || 10) + '题');
            }
            if (battle.isHost) {
                editBtn.classList.remove('hidden');
            } else {
                editBtn.classList.add('hidden');
            }
            
            if (battle.isHost) { 
                sBtn.classList.remove('hidden'); 
                rBtn.classList.add('hidden');
                wMsg.classList.add('hidden'); 
            } else { 
                sBtn.classList.add('hidden'); 
                var me = room.players.find(p => p.name === user.name);
                if (me && me.isReady) {
                    rBtn.classList.add('hidden');
                    wMsg.classList.remove('hidden');
                } else {
                    rBtn.classList.remove('hidden');
                    rBtn.disabled = false;
                    rBtn.innerHTML = "🙋‍♂️ 准备";
                    wMsg.classList.add('hidden'); 
                }
            }
            
            clearInterval(battle.pollInterval);
            
            // 使用 ?_t= 强制穿透网络死缓存，保证所有人能实时看到对方和开局指令
            battle.pollInterval = setInterval(async function() { 
                try { 
                    var rm = await apiFetch('/api/battle/poll?_t=' + Date.now(), {
                        method: 'POST', 
                        headers: {'Content-Type':'application/json'}, 
                        body: JSON.stringify({roomCode: battle.roomCode})
                    }); 
                    if (rm && rm.players) {
                        updateRoomPlayers(rm); 
                        // 防跑单：只要轮询到游戏状态是 playing 且拿到题目，全员（含房主）瞬间统一切换界面
                        if (rm.status === 'playing' && rm.questions && rm.questions.length > 0) { 
                            if (!document.getElementById('screen-battle-play').classList.contains('flex')) {
                                clearInterval(battle.pollInterval); 
                                startBattlePlay(rm); 
                            }
                        }
                    }
                } catch(e) {
                    console.error("Room sync error:", e);
                } 
            }, 1000); // 轮询频率调快到1秒，保证进场丝滑
        }

        // 处理点击准备
        document.getElementById('btn-ready-battle').onclick = async function() {
            this.disabled = true;
            this.innerHTML = "正在准备...";
            try {
                await apiFetch('/api/battle/ready', {
                    method: 'POST',
                    headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({roomCode: battle.roomCode, name: user.name})
                });
                this.classList.add('hidden');
                document.getElementById('waiting-msg').classList.remove('hidden');
            } catch(e) {
                customAlert("准备失败: " + e.message);
                this.disabled = false;
                this.innerHTML = "🙋‍♂️ 准备";
            }
        };

        function updateRoomPlayers(room) {
            if (!room || !room.players) return;
            var html = ''; 
            var allReady = true;
            for (var i = 0; i < room.players.length; i++) {
                var p = room.players[i];
                var isMe = p.name === user.name; 
                var boxClass = isMe ? 'bg-theme-light border-2 border-theme-main' : 'bg-white border-2 border-gray-100';
                
                if (!p.isReady) allReady = false;

                html += '<div class="flex items-center gap-3 p-2 rounded-xl ' + boxClass + '">';
                html += '<div class="text-3xl">' + p.avatar + '</div>';
                html += '<div class="flex-grow"><div class="font-black text-gray-700 text-sm">' + p.name + (isMe ? ' (我)' : '') + '</div>';
                if (room.host === p.name) {
                    html += '<div class="text-[10px] text-orange-500 font-bold">👑 房主</div>';
                }
                html += '</div>';
                
                // 显示准备状态
                if (p.isReady) {
                    html += '<div class="text-green-500 font-bold text-xs">✓ 已准备</div>';
                } else {
                    html += '<div class="text-gray-400 font-bold text-xs animate-pulse">⏳ 准备中</div>';
                }
                
                html += '</div>'; 
            }
            document.getElementById('room-players-list').innerHTML = html;
            
            // 房主界面动态显示当前人数和准备情况
            if (battle.isHost) {
                var sBtn = document.getElementById('btn-start-battle');
                if (sBtn && sBtn.innerHTML.indexOf("正在") === -1 && sBtn.innerHTML.indexOf("等待全员") === -1) {
                    if (room.players.length >= 2 && allReady) {
                        sBtn.innerHTML = "🚀 全员准备完毕，开始对战！";
                        sBtn.style.opacity = "1";
                        sBtn.disabled = false;
                    } else if (room.players.length >= 2 && !allReady) {
                        var readyCount = room.players.filter(p => p.isReady).length;
                        sBtn.innerHTML = "等待成员准备... (" + readyCount + "/" + room.players.length + ")";
                        sBtn.style.opacity = "0.6";
                        sBtn.disabled = true; // 有人没准备，强制锁定！
                    } else {
                        sBtn.innerHTML = "等待成员加入... (1/4)";
                        sBtn.style.opacity = "0.6";
                        sBtn.disabled = true; // 只有1个人，强制锁定！
                    }
                }
            }
        }

        // 房主点击发车时不立刻跳转，而是向后端发送指令，并等待轮询统一开局
        document.getElementById('btn-start-battle').onclick = async function() {
            if (!battle.isHost) return; 
            
            this.disabled = true;
            this.style.opacity = "0.6";
            this.innerHTML = "正在下发指令...";

            var qs = generateQuestions(battle.grade, battle.types, battle.count); 
            var qd = [];
            for (var i = 0; i < qs.length; i++) {
                qd.push({ q: qs[i].q, a: qs[i].a });
            }
            
            try { 
                await apiFetch('/api/battle/start', { 
                    method: 'POST', 
                    headers: {'Content-Type':'application/json'}, 
                    body: JSON.stringify({ roomCode: battle.roomCode, questions: qd }) 
                }); 
                // 我们在这里不立刻调用 startBattlePlay 了
                // 而是等待上面的 pollInterval 轮询监听到状态变更为 playing，大家统一发车
                this.innerHTML = "等待全员同步开局...";
            } catch(e) { 
                customAlert("发车失败: " + e.message);
                this.disabled = false;
                this.style.opacity = "1";
                this.innerHTML = "🚀 全员准备完毕，开始对战！";
            } 
        };

        // ==========================================
        // 多人对战执行与结算逻辑
        // ==========================================
        async function leaveBattleRoom() {
            if (!battle.roomCode) return;
            clearInterval(battle.pollInterval);
            try {
                await apiFetch('/api/battle/leave', {
                    method: 'POST', 
                    headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({ roomCode: battle.roomCode, name: user.name })
                });
            } catch(e) {}
            battle.roomCode = "";
        }

        document.getElementById('btn-leave-room').onclick = async function() { 
            await leaveBattleRoom(); 
            showScreen('screen-battle-lobby'); 
        };

        function startBattlePlay(room) {
            battle.questions = room.questions || []; 
            battle.currentIndex = 0; 
            battle.currentInput = ""; 
            battle.isProcessing = false; 
            battle.combo = 0; 
            battle.mistakes = []; 
            battle.correctOnes = []; 
            battle.myProgress = 0; 
            battle.finished = false; 
            battle.timePenalty = 0; 
            battle.startTime = Date.now();
            
            document.getElementById('battle-waiting-overlay').classList.add('hidden'); 
            showScreen('screen-battle-play'); 
            // 首次渲染赛道（确保进入游戏时立即看到所有玩家）
            if (room.players && room.players.length > 0) {
                renderBattleTracks(room.players);
            }
            renderBattleQuestion();
            
            clearInterval(battle.timer); 
            battle.timer = setInterval(function() { 
                var currentSec = (Date.now() - battle.startTime) / 1000 + battle.timePenalty;
                safeSet('battle-timer-text', currentSec.toFixed(1) + 's'); 
            }, 100);
            
            clearInterval(battle.pollInterval); 
            
            battle.pollInterval = setInterval(async function() { 
                try { 
                    var rm = await apiFetch('/api/battle/poll?_t=' + Date.now(), {
                        method: 'POST', 
                        headers: {'Content-Type':'application/json'}, 
                        body: JSON.stringify({roomCode: battle.roomCode})
                    }); 
                    
                    if (!rm || !rm.players) return;
                    
                    renderBattleTracks(rm.players);
                    
                    var me = null;
                    for(var p=0; p<rm.players.length; p++) {
                        if (rm.players[p].name === user.name) {
                            me = rm.players[p];
                            break;
                        }
                    }
                    
                    if (me && me.tauntMsg && me.tauntTime && (Date.now() - me.tauntTime < 3500)) {
                        showBattleTaunt(me.tauntMsg, me.tauntFrom); 
                    }
                    if (rm.status === 'finished' && battle.finished) { 
                        clearInterval(battle.pollInterval); 
                        clearInterval(battle.timer); 
                        document.getElementById('battle-waiting-overlay').classList.add('hidden'); 
                        showBattleResult(rm); 
                    }
                } catch(e) {
                    console.error("Battle sync error:", e);
                } 
            }, 1000);
        }

        function renderBattleTracks(players) {
            if (!players) return;
            var html = ''; 
            for (var i = 0; i < players.length; i++) {
                var p = players[i];
                var isMe = p.name === user.name;
                var totalQ = battle.questions.length || 1;
                var pct = Math.min((p.progress / totalQ) * 85, 88); 
                html += '<div class="flex items-center gap-2">';
                html += '<div class="text-xl w-7 flex-shrink-0">' + p.avatar + '</div>';
                html += '<div class="flex-grow battle-track">';
                html += '<div class="absolute text-lg z-10 transition-all duration-500" style="left:' + pct + '%;top:50%;transform:translateY(-50%)">' + p.avatar + '</div>';
                if (p.finished) html += '<div class="finish-flag">🏁</div>';
                html += '</div>';
                
                var textColor = isMe ? 'text-theme-main' : 'text-gray-400';
                html += '<div class="text-xs font-black w-12 text-right ' + textColor + '">' + p.progress + '/' + totalQ + '</div></div>'; 
            }
            document.getElementById('battle-tracks-container').innerHTML = html;
        }

        function showBattleTaunt(text, from) {
            var el = document.getElementById('battle-taunt-display'); 
            safeSet('battle-taunt-text', text); 
            safeSet('battle-taunt-from', from + ' 的嘲讽');
            
            var ic = '😈'; 
            if (text.includes('🔥')) ic = '🔥'; 
            if (text.includes('💥')) ic = '💥'; 
            if (text.includes('🐉')) ic = '🐉'; 
            if (text.includes('👑')) ic = '👑'; 
            safeSet('battle-taunt-icon', ic);
            
            el.classList.remove('hidden'); 
            var b = document.getElementById('battle-taunt-bubble'); 
            b.classList.remove('taunt-popup'); 
            void b.offsetWidth; 
            b.classList.add('taunt-popup');
            
            clearTimeout(el._tt); 
            el._tt = setTimeout(function() { el.classList.add('hidden'); }, 3500);
        }

        function renderBattleQuestion() {
            if (battle.currentIndex >= battle.questions.length) return; 
            var q = battle.questions[battle.currentIndex]; 
            document.getElementById('battle-question-text').innerHTML = q.q + ' <span class="text-theme-main text-3xl">=</span>'; 
            safeSet('battle-progress-text', '第 ' + (battle.currentIndex + 1) + '/' + battle.questions.length + ' 题'); 
            
            battle.currentInput = ""; 
            battle.isProcessing = false; 
            
            var d = document.getElementById('battle-answer-display'); 
            d.style.borderColor = 'var(--border-main)'; 
            d.style.background = 'white'; 
            document.getElementById('battle-answer-value').style.color = 'var(--text-main)'; 
            updateBattleAnswerUI();
        }
        
        function updateBattleAnswerUI() { 
            var el = document.getElementById('battle-answer-value'); 
            if (!battle.currentInput) { 
                el.innerHTML = '<span style="color:#CBD5E1">输入答案</span>'; 
                el.classList.add('animate-pulse'); 
            } else { 
                el.innerText = battle.currentInput; 
                el.classList.remove('animate-pulse'); 
            } 
        }
        
        window.handleBattleInput = function(v) {
            if (battle.isProcessing) return; 
            if (v === 'del') {
                battle.currentInput = battle.currentInput.slice(0, -1); 
            } else if (v === 'enter') {
                checkBattleAnswer(); 
            } else if (battle.currentInput.length < 8) { 
                if (v === '.' && battle.currentInput.includes('.')) return; 
                battle.currentInput += v; 
            } 
            updateBattleAnswerUI();
        };

        async function checkBattleAnswer() {
            if (!battle.currentInput || battle.isProcessing) return; 
            battle.isProcessing = true; 
            
            var q = battle.questions[battle.currentIndex]; 
            var isCorrect = parseFloat(battle.currentInput) === q.a; 
            var d = document.getElementById('battle-answer-display');
            
            if (isCorrect) {
                battle.combo++; 
                battle.correctOnes.push(q.q); 
                battle.myProgress++; 
                d.style.background = '#F0FFF4'; 
                d.style.borderColor = '#34D399'; 
                document.getElementById('battle-answer-value').style.color = '#059669';
                
                var td = null; 
                if (battle.combo >= 3) { 
                    var t = getTaunt(battle.combo); 
                    if (t) { td = t.text; } 
                    var ce = document.getElementById('battle-combo-display'); 
                    ce.innerText = battle.combo + '连击 🔥'; 
                    ce.style.opacity = '1'; 
                    setTimeout(function(){ ce.style.opacity = '0'; }, 1500); 
                }
                
                try { 
                    var payload = { 
                        roomCode: battle.roomCode, 
                        name: user.name, 
                        progress: battle.myProgress, 
                        finished: false, // 不在这里标记完成，由 finishBattle 带上 time 一起发
                        combo: battle.combo, 
                        taunt: td 
                    };
                    await apiFetch('/api/battle/update', { 
                        method: 'POST', 
                        headers: {'Content-Type':'application/json'}, 
                        body: JSON.stringify(payload) 
                    }); 
                } catch (e) {}
                
                setTimeout(nextBattleQuestion, 250);
            } else {
                battle.combo = 0; 
                battle.mistakes.push({ q: q.q, correctAns: q.a, myAns: battle.currentInput }); 
                battle.timePenalty += 10;
                
                d.style.background = '#FFF5F5'; 
                d.style.borderColor = '#F87171'; 
                document.getElementById('battle-answer-value').style.color = '#EF4444'; 
                
                var pen = document.createElement('div'); 
                pen.className = 'absolute -top-4 right-4 text-red-500 font-black text-2xl animate-pop pointer-events-none z-50'; 
                pen.innerText = '+10s'; 
                d.appendChild(pen); 
                setTimeout(function() { pen.remove(); }, 1000);
                
                setTimeout(function(){ nextBattleQuestion(); }, 400); 
            }
        }
        
        function nextBattleQuestion() { 
            battle.currentIndex++; 
            if (battle.currentIndex >= battle.questions.length) {
                finishBattle(); 
            } else {
                renderBattleQuestion(); 
            }
        }

        async function finishBattle() {
            battle.finished = true; 
            // 计算总时间：实际流逝时间 + 罚时
            var tt = (Date.now() - battle.startTime) / 1000 + battle.timePenalty; 
            var acc = Math.round(((battle.questions.length - battle.mistakes.length) / battle.questions.length) * 100);
            
            document.getElementById('battle-waiting-overlay').classList.remove('hidden'); 
            safeSet('battle-final-time-preview', tt.toFixed(1) + 's');
            
            try {
                var payloadFinish = { 
                    roomCode: battle.roomCode, 
                    name: user.name, 
                    progress: battle.questions.length, 
                    finished: true, 
                    time: tt, 
                    accuracy: acc 
                };
                await apiFetch('/api/battle/update', { 
                    method: 'POST', 
                    headers: {'Content-Type':'application/json'}, 
                    body: JSON.stringify(payloadFinish) 
                });
                
                var bc = Math.ceil(battle.questions.length + Math.floor(acc / 10));
                var cg = Math.ceil(bc * 1.2);
                
                var payloadSave = { 
                    name: user.name, 
                    result: { 
                        exp: 0, 
                        coinsGained: cg, 
                        time: tt, 
                        mistakes: battle.mistakes, 
                        correctOnes: battle.correctOnes, 
                        accuracy: acc, 
                        configKey: 'room' 
                    } 
                };
                var resData = await apiFetch('/api/save-result', { 
                    method: 'POST', 
                    headers: {'Content-Type':'application/json'}, 
                    body: JSON.stringify(payloadSave) 
                });
                
                var curName = user.name;
                user = resData.user;
                user.name = curName;
                battle._coinsGained = cg; 
                updateUI();
            } catch(e) {}
            
            var dl = Date.now() + 60000; 
            clearInterval(battle.pollInterval);
            
            battle.pollInterval = setInterval(async function() {
                try { 
                    // 使用原生 fetch 而非 apiFetch，避免房间被清理后弹出"房间不存在"的错误提示
                    var res = await fetch('/api/battle/poll?_t=' + Date.now(), {
                        method: 'POST', 
                        headers: {'Content-Type':'application/json'}, 
                        body: JSON.stringify({roomCode: battle.roomCode})
                    });
                    if (!res.ok) {
                        // 房间已不存在，直接显示结果
                        clearInterval(battle.pollInterval); 
                        clearInterval(battle.timer); 
                        document.getElementById('battle-waiting-overlay').classList.add('hidden'); 
                        showBattleResult(null); 
                        return;
                    }
                    var rm = await res.json();
                    if (Date.now() > dl || rm.status === 'finished') { 
                        clearInterval(battle.pollInterval); 
                        clearInterval(battle.timer); 
                        document.getElementById('battle-waiting-overlay').classList.add('hidden'); 
                        showBattleResult(rm); 
                        return; 
                    }
                    if (rm && rm.players) renderBattleTracks(rm.players);
                } catch(e) {}
            }, 1000);
        }

        function showBattleResult(room) {
            showScreen('screen-battle-result'); 
            safeSet('battle-coins-earned', '+' + (battle._coinsGained || 0));
            
            if (!room || !room.players) { 
                safeSet('battle-result-msg', '对战完成！'); 
                safeSet('battle-result-badge', '🏆'); 
                document.getElementById('battle-rankings').innerHTML = '<div class="text-center text-gray-400 font-bold">等待结果...</div>'; 
                return; 
            }
            
            var sorted = room.players.slice().sort(function(a,b) { 
                if (a.finished && b.finished) return a.time - b.time; 
                if (a.finished) return -1; 
                if (b.finished) return 1; 
                return b.progress - a.progress; 
            });
            
            var myR = -1;
            for (var m = 0; m < sorted.length; m++) {
                if (sorted[m].name === user.name) {
                    myR = m + 1;
                    break;
                }
            }
            
            var rE = ['🥇','🥈','🥉','4️⃣']; 
            var h = '';
            
            for (var i = 0; i < sorted.length; i++) {
                var p = sorted[i];
                var isM = p.name === user.name; 
                var boxC = isM ? 'bg-theme-light border-theme-main' : 'bg-gray-50 border-gray-100';
                
                h += '<div class="flex items-center gap-3 p-3 rounded-2xl border-2 ' + boxC + '">';
                h += '<div class="text-3xl">' + (rE[i] || '🏅') + '</div>';
                h += '<div class="text-3xl">' + p.avatar + '</div>';
                h += '<div class="flex-grow"><div class="font-black text-sm">' + p.name + (isM ? ' (我)' : '') + '</div>';
                
                var stat = p.finished ? '总用时 ' + p.time.toFixed(1) + 's' : '进度 ' + p.progress + '/' + room.questions.length + '题';
                h += '<div class="text-xs text-gray-500">' + stat + '</div></div></div>'; 
            }
            document.getElementById('battle-rankings').innerHTML = h;
            
            safeSet('battle-result-badge', myR === 1 ? '🥇' : myR === 2 ? '🥈' : myR === 3 ? '🥉' : '😅'); 
            safeSet('battle-result-msg', myR === 1 ? '你是第一！太强了！' : myR === 2 ? '第二名！再努力！' : myR === 3 ? '第三名！继续加油！' : '下次再战！');
            
            // leaveBattleRoom moved to btn-battle-restart to prevent removing player data before others poll
        }

        document.getElementById('btn-battle-back-room').onclick = async function() {
            try {
                var d = await apiFetch('/api/battle/reset', {
                    method: 'POST',
                    headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({roomCode: battle.roomCode})
                });
                battle.finished = false;
                battle.currentIndex = 0;
                battle.myProgress = 0;
                battle.timePenalty = 0;
                battle.combo = 0;
                battle.mistakes = [];
                battle.correctOnes = [];
                battle.tauntedMilestones = {};
                clearInterval(battle.pollInterval);
                clearInterval(battle.timer);
                if (d && d.room) {
                    showBattleRoom(d.room);
                } else {
                    showScreen('screen-battle-lobby');
                }
            } catch(e) {
                customAlert('房间已解散，返回大厅');
                showScreen('screen-battle-lobby');
            }
        };

        document.getElementById('btn-battle-restart').onclick = async function() { 
            await leaveBattleRoom();
            showScreen('screen-setup'); 
            updateUI(); 
        };
        
        document.getElementById('btn-edit-room-config').onclick = function() {
            showScreen('screen-battle-lobby');
            document.getElementById('btn-create-room').click();
            document.getElementById('btn-create-confirm').textContent = '✅ 保存配置';
            document.getElementById('btn-create-confirm').onclick = async function() {
                var gradeEl = document.querySelector('input[name="battleGrade"]:checked');
                var grade = gradeEl ? gradeEl.value : 'g34';
                var types = [];
                document.querySelectorAll('#battle-type-checkboxes input:checked').forEach(function(cb) { types.push(cb.value); });
                var countEl = document.querySelector('input[name="battleCount"]:checked');
                var count = countEl ? parseInt(countEl.value) : 10;
                try {
                    var d = await apiFetch('/api/battle/config', {
                        method: 'POST',
                        headers: {'Content-Type':'application/json'},
                        body: JSON.stringify({roomCode: battle.roomCode, grade: grade, types: types, count: count})
                    });
                    battle.grade = grade;
                    battle.types = types;
                    battle.count = count;
                    if (d && d.room) showBattleRoom(d.room);
                } catch(e) { customAlert('保存失败'); }
            };
        };
        
        var battleKeypadBtns = document.querySelectorAll('.battle-keypad-btn');
        for (var k = 0; k < battleKeypadBtns.length; k++) {
            battleKeypadBtns[k].onpointerdown = function(e) { 
                e.preventDefault(); 
                handleBattleInput(e.currentTarget.getAttribute('data-val')); 
            };
        }

    })();
    </script>
</body>
</html>`;
