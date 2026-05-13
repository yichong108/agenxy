export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-between p-24">
      <div className="z-10 max-w-5xl w-full items-center justify-between font-mono text-sm">
        <h1 className="text-4xl font-bold mb-4">Agenxy</h1>
        <p className="text-xl text-gray-600 mb-8">AI Agent 桌面应用</p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12">
          <FeatureCard
            title="本地优先"
            description="数据完全在本地处理，保护您的隐私"
          />
          <FeatureCard
            title="智能助手"
            description="基于大语言模型的智能对话与任务执行"
          />
          <FeatureCard
            title="可扩展"
            description="支持 MCP 协议，可接入各种工具和服务"
          />
        </div>

        <div className="mt-12 flex gap-4">
          <a
            href="#download"
            className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
          >
            下载应用
          </a>
          <a
            href="https://github.com/your-org/agenxy"
            className="px-6 py-3 border border-gray-300 rounded-lg hover:bg-gray-100 transition"
          >
            GitHub
          </a>
        </div>
      </div>
    </main>
  )
}

function FeatureCard({
  title,
  description
}: {
  title: string
  description: string
}) {
  return (
    <div className="p-6 border border-gray-200 rounded-lg">
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      <p className="text-gray-600">{description}</p>
    </div>
  )
}
