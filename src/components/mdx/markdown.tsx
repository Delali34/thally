'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownProps {
  children: string
  className?: string
}

export function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              className="font-medium text-accent underline decoration-dotted underline-offset-4 transition hover:text-accent/80"
              target="_blank"
              rel="noreferrer"
            >
              {children}
            </a>
          ),
          p: ({ children }) => <p className="leading-relaxed">{children}</p>,
          // The inline-code ring and size must not leak into a fenced block's own `code` element.
          pre: ({ children }) => <pre className="[&>code]:bg-transparent [&>code]:p-0 [&>code]:shadow-none [&>code]:[font-size:inherit]">{children}</pre>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

export default Markdown
