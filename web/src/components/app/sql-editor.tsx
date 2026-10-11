import { sql } from "@codemirror/lang-sql"
import CodeMirror, { keymap } from "@uiw/react-codemirror"
import { useMemo } from "react"

import { useTheme } from "@/components/theme-provider"

function useResolvedTheme(): "light" | "dark" {
  const { theme } = useTheme()
  if (theme !== "system") return theme
  return typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light"
}

export function SqlEditor({
  value,
  onChange,
  onRun,
  schema,
  height = "220px",
  readOnly,
}: {
  value: string
  onChange?: (value: string) => void
  onRun?: () => void
  schema?: Record<string, string[]>
  height?: string
  readOnly?: boolean
}) {
  const theme = useResolvedTheme()
  const extensions = useMemo(
    () => [
      sql({ schema, upperCaseKeywords: true }),
      keymap.of(
        onRun
          ? [
              { key: "Mod-Enter", run: () => (onRun(), true) },
              { key: "F8", run: () => (onRun(), true) },
            ]
          : []
      ),
    ],
    [schema, onRun]
  )
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      height={height}
      theme={theme}
      readOnly={readOnly}
      extensions={extensions}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: !readOnly,
      }}
      className="overflow-hidden rounded-lg border text-sm"
    />
  )
}
