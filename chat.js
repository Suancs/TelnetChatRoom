const net = require('net');
const fs = require('fs');
const iconv = require('iconv-lite'); // 添加编码转换库

// 全局变量
const PORT = 6666; //这里填写端口
const HISTORY_FILE = 'history.txt'; //这里填写聊天记录保存的位置
let history = [];
let clients = new Map(); // socket -> username
let usernames = new Set();

// 加载历史记录（移除颜色代码）
function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const data = fs.readFileSync(HISTORY_FILE, 'utf8');
            const lines = data.split('\n')
                .map(line => line.replace(/\x1b\[\d+m/g, '')) // 移除所有ANSI颜色代码
                .filter(line => line.trim());
            history = lines.slice(-100); // 保留最后100条
        }
    } catch (err) {
        console.error('Error loading history:', err);
    }
}

// 保存消息到历史记录（使用纯文本）
function saveToHistory(message) {
    const plainText = message.replace(/\x1b\[\d+m/g, '');
    history.push(plainText);
    if (history.length > 100) history.shift();

    try {
        // 同步写入历史记录
        fs.writeFileSync(HISTORY_FILE, history.join('\n') + '\n');
    } catch (err) {
        console.error('Error saving history:', err);
    }
}

// 格式化时间 HH:MM:SS
function getCurrentTime() {
    const now = new Date();
    return now.toTimeString().slice(0, 8);
}

// 处理消息广播
function broadcast(sender, message) {
    const time = getCurrentTime();
    const username = clients.get(sender);

    if (!username) {
        if (sender && typeof sender.write === 'function') {
            // 使用GBK编码发送
            sender.write(iconv.encode('发送消息失败：未注册用户名。\r\n', 'gbk'));
        }
        return;
    }

    // 构建带颜色的消息 (UTF-8)
    const coloredMessage = `${time} [ \x1b[31m${username}\x1b[0m ] ： ${message}\r\n`;
    const plainMessage = `${time} [ ${username} ] ： ${message}`;

    // 发送带颜色的消息 (转换为GBK)
    for (const [client] of clients) {
        client.write(iconv.encode(coloredMessage, 'gbk'));
    }

    // 保存纯文本到历史
    saveToHistory(plainMessage);
}

// 广播系统通知
function broadcastSystemNotice(message) {
    const time = getCurrentTime();
    const coloredNotice = `${time} [ \x1b[33mSystem\x1b[0m ] ： ${message}\r\n`;
    const plainNotice = `${time} [ System ] ： ${message}`;

    for (const client of clients.keys()) {
        client.write(iconv.encode(coloredNotice, 'gbk'));
    }

    saveToHistory(plainNotice);
}

// 配置常量
const MAX_NAME_LENGTH = 20;
const MAX_MESSAGE_LENGTH = 200;

// 处理新连接
const server = net.createServer((socket) => {
    // 移除 setEncoding，手动处理编码
    let username = '';
    let inputBuffer = Buffer.alloc(0); // 使用Buffer处理输入
    let isAwaitingName = true;

    // 发送消息辅助函数
    const sendGBK = (text) => {
        socket.write(iconv.encode(text, 'gbk'));
    };

    // 输入处理函数
    const processInput = (input) => {
        // 将GBK输入转换为UTF-8
        const utf8Input = iconv.decode(input, 'gbk').replace(/\r\n$/, '');
        
        if (isAwaitingName) {
            handleNameInput(utf8Input);
        } else {
            handleChatInput(utf8Input);
        }
    };

    // 处理名字输入
    const handleNameInput = (input) => {
        if (!input) {
            sendGBK('名称不能为空，请重新输入： ');
            return;
        }

        if (input.length > MAX_NAME_LENGTH) {
            sendGBK(`名称过长，不能超过${MAX_NAME_LENGTH}个字符，请重新输入： `);
            return;
        }

        if (usernames.has(input)) {
            sendGBK('名称已存在，请重新输入： ');
            return;
        }

        username = input;
        usernames.add(username);
        clients.set(socket, username);
        isAwaitingName = false;

        // 发送欢迎消息和历史记录
        sendGBK(`\r\n欢迎加入聊天室，${username}！\r\n`);
        sendGBK('输入 /list 查看在线用户\r\n\r\n');

        if (history.length > 0) {
            sendGBK('--- 历史消息 ---\r\n');
            history.forEach(msg => sendGBK(msg + '\r\n'));
            sendGBK('---------------\r\n\r\n');
        }

        broadcastSystemNotice(`${username} 加入了聊天室`);
    };

    // 处理聊天输入
    const handleChatInput = (input) => {
        if (input.startsWith('/')) {
            handleCommand(input.slice(1));
            return;
        }

        if (input.trim()) {
            broadcast(socket, input);
        }
    };

    // 处理命令
    const handleCommand = (command) => {
        switch(command.toLowerCase()) {
            case 'list':
                const count = usernames.size;
                sendGBK(`当前在线用户(${count})：\r\n`);
                usernames.forEach(name => sendGBK(`- ${name}\r\n`));
                break;
            default:
                sendGBK('未知命令。\r\n');
        }
    };

    // 数据接收处理
    socket.on('data', (chunk) => {
        inputBuffer = Buffer.concat([inputBuffer, chunk]);
        
        // 查找换行符位置
        let newlineIndex;
        while ((newlineIndex = inputBuffer.indexOf(0x0D)) !== -1) { // 查找 \r
            if (inputBuffer.length > newlineIndex + 1 && inputBuffer[newlineIndex + 1] === 0x0A) { // 检查 \n
                const line = inputBuffer.slice(0, newlineIndex);
                inputBuffer = inputBuffer.slice(newlineIndex + 2);
                processInput(line);
            } else {
                break;
            }
        }
    });

    socket.on('close', () => {
        if (!isAwaitingName) {
            usernames.delete(username);
            clients.delete(socket);
            broadcastSystemNotice(`${username} 离开了聊天室`);
        }
    });

    socket.on('error', (err) => {
        if (err.code !== 'ECONNRESET') {
            console.error('Socket error:', err);
        }
    });

    // 初始提示 (使用GBK编码)
    sendGBK('设置昵称： ');
});

// 初始化和启动服务器
loadHistory();
server.listen(PORT, () => {
    console.log(`Telnet聊天室运行在端口 ${PORT}`);
});
