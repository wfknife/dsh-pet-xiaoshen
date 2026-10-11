// upload-cos.mjs — 把发布产物（exe/version.json/latest.yml/blockmap）上传到腾讯云 COS。
// 密钥从环境变量读取（不写进命令行/代码）：
//   set COS_SECRET_ID=AKIDxxxx
//   set COS_SECRET_KEY=xxxx
//   set COS_BUCKET=deskpet-updates-xxxx
//   set COS_REGION=ap-guangzhou
// 用法：node build/upload-cos.mjs [--dir <updates目录>]
import { readdirSync, statSync, createReadStream } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import COS from 'cos-nodejs-sdk-v5'

const bucket = process.env.COS_BUCKET
const region = process.env.COS_REGION
const secretId = process.env.COS_SECRET_ID
const secretKey = process.env.COS_SECRET_KEY
const dirIdx = process.argv.indexOf('--dir')
const dir = dirIdx >= 0 ? process.argv[dirIdx + 1] : join(homedir(), 'dsh-updates')

if (!bucket || !region || !secretId || !secretKey) {
  console.error('缺少环境变量：需设置 COS_BUCKET / COS_REGION / COS_SECRET_ID / COS_SECRET_KEY')
  console.error('示例：')
  console.error('  $env:COS_BUCKET="deskpet-updates-1470499795"')
  console.error('  $env:COS_REGION="ap-guangzhou"')
  console.error('  $env:COS_SECRET_ID="AKID..."')
  console.error('  $env:COS_SECRET_KEY="..."')
  console.error('  node build/upload-cos.mjs')
  process.exit(1)
}

const cos = new COS({ SecretId: secretId, SecretKey: secretKey })
const PREFIX = 'updates/' // 桶内统一放 updates/ 目录，与桌宠代码的 /updates/ 路径匹配

// 需要上传的文件（exe/blockmap/latest.yml/version.json 等发布产物）
const files = readdirSync(dir).filter((n) => !n.endsWith('.blockmap.diff') && !n.startsWith('.'))
const uploads = files.map((n) => ({ key: PREFIX + n, path: join(dir, n), size: statSync(join(dir, n)).size }))

let ok = 0
const failed = []
for (const f of uploads) {
  try {
    await new Promise((resolve, reject) => {
      cos.putObject(
        {
          Bucket: bucket,
          Region: region,
          Key: f.key,
          Body: createReadStream(f.path),
          // 更新清单不要被 CDN/浏览器缓存
          CacheControl: f.key.endsWith('.yml') || f.key.endsWith('.json') || f.key.endsWith('.blockmap') ? 'no-cache' : 'public, max-age=3600',
        },
        (err, data) => (err ? reject(err) : resolve(data))
      )
    })
    ok++
    console.log('  uploaded:', f.key, '(' + Math.round((f.size / 1048576) * 10) / 10 + ' MB)')
  } catch (err) {
    failed.push(f.key + ': ' + (err && err.message))
  }
}

console.log(`\n[upload-cos] ${ok}/${uploads.length} uploaded to ${bucket}.cos.${region}.myqcloud.com`)
if (failed.length) {
  console.error('失败项:')
  failed.forEach((f) => console.error('  ', f))
  process.exit(1)
}
