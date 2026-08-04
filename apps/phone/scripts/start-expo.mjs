/**
 * 使用真实局域网 IP 启动 Expo，避免选中 VMware / Clash / Hyper-V 等虚拟网卡
 *
 * 通过 REACT_NATIVE_PACKAGER_HOSTNAME 覆盖 Metro 广播地址，
 * 使 Expo Go 二维码指向可被手机访问的 WLAN IP。
 *
 * 用法：node ./scripts/start-expo.mjs [expo 额外参数...]
 * 也可手动指定：REACT_NATIVE_PACKAGER_HOSTNAME=x.x.x.x node ./scripts/start-expo.mjs
 */
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const VIRTUAL_IFACE =
  /vmware|virtualbox|hyper-?v|vethernet|docker|wsl|loopback|clash|tap|tun|vpn|hamachi|zerotier|radmin/i;

/**
 * 选取优先用于 Expo 广播的 IPv4 地址
 *
 * @returns 局域网 IPv4；找不到时返回 undefined
 */
function pickLanIpv4() {
  if (process.env.REACT_NATIVE_PACKAGER_HOSTNAME) {
    return process.env.REACT_NATIVE_PACKAGER_HOSTNAME;
  }

  const nets = networkInterfaces();
  /** @type {{ name: string; address: string; preferred: boolean }[]} */
  const candidates = [];

  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs || VIRTUAL_IFACE.test(name)) continue;

    for (const addr of addrs) {
      const family = addr.family;
      const isV4 = family === 'IPv4' || family === 4;
      if (!isV4 || addr.internal) continue;
      // Clash TUN 假网段
      if (addr.address.startsWith('198.18.')) continue;
      // 常见虚拟网段兜底过滤
      if (/^(192\.168\.(56|57|58|59|221|204)\.|172\.(1[6-9]|2\d|3[01])\.)/.test(addr.address) &&
          /vmware|vethernet|hyper/i.test(name)) {
        continue;
      }

      const preferred = /wlan|wi-?fi|无线|ethernet|以太网|本地连接/i.test(name);
      candidates.push({ name, address: addr.address, preferred });
    }
  }

  candidates.sort((a, b) => Number(b.preferred) - Number(a.preferred));
  return candidates[0]?.address;
}

const lanIp = pickLanIpv4();
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const phoneRoot = path.resolve(scriptsDir, '..');
const expoArgs = ['expo', 'start', ...process.argv.slice(2)];

if (lanIp) {
  process.env.REACT_NATIVE_PACKAGER_HOSTNAME = lanIp;
  console.log(`[phone] Metro host -> ${lanIp} (exp://${lanIp}:8081)`);
} else {
  console.warn('[phone] 未找到可用局域网 IP，将使用 Expo 默认网卡选择');
}

const child = spawn('pnpm', ['exec', ...expoArgs], {
  cwd: phoneRoot,
  env: process.env,
  stdio: 'inherit',
  shell: true,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
