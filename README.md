# NeteaseMusicHelper

网易云音乐辅助脚本集合。

## 随机打乱歌单歌曲顺序

脚本：`shuffle-netease-playlist.js`

功能：登录网易云音乐后，读取指定歌单里的所有歌曲，使用 Fisher-Yates 洗牌算法随机打乱顺序，然后调用网易云音乐接口提交新的歌单顺序。

### 安装

```bash
npm install
```

### 预览，不修改歌单

```bash
node shuffle-netease-playlist.js --playlist 'https://music.163.com/playlist?id=你的歌单ID' --dry-run
```

### 执行打乱

```bash
node shuffle-netease-playlist.js --playlist 'https://music.163.com/playlist?id=你的歌单ID'
```

也可以直接传歌单 ID：

```bash
node shuffle-netease-playlist.js -p 123456789
```

### 登录说明

第一次运行时，终端会显示二维码。请使用网易云音乐 App 扫码并在手机上确认登录。
登录 cookie 会保存到 `.netease-cookie.json`，后续运行会自动复用。

如果需要重新登录：

```bash
node shuffle-netease-playlist.js -p 123456789 --force-login
```

### 注意事项

- 只能调整你自己有编辑权限的歌单。
- `--dry-run` 会展示打乱前后前 10 首歌曲，但不会提交修改。
- `.netease-cookie.json` 包含登录态，已加入 `.gitignore`，不要提交或分享。
