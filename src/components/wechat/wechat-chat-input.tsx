import { useRef, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Send } from "lucide-react"

interface WechatChatInputProps {
  onSend: (text: string) => void
  placeholder: string
}

export function WechatChatInput({ onSend, placeholder }: WechatChatInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const text = inputRef.current?.value.trim()
      if (!text) return
      onSend(text)
      if (inputRef.current) inputRef.current.value = ""
    },
    [onSend],
  )

  return (
    <div className="border-t p-3 shrink-0">
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          placeholder={placeholder}
          className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <Button type="submit" size="sm">
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </div>
  )
}
