import type { Components } from "react-markdown"
import { useCodeCopy } from "../presenters/codeCopyPresenter"
import { useMermaid } from "../presenters/markdownPresenter"
import { t } from "../i18n"

export const MarkdownCodeBlock: NonNullable<Components["pre"]> = ({ children, node }) => {
  const code = node?.children.find((child) => child.type === "element" && child.tagName === "code")
  const textContent = (node: NonNullable<typeof code>): string =>
    node.type === "text" ? node.value : "children" in node ? node.children.map(textContent).join("") : ""
  const text = code ? textContent(code) : ""
  const classes = code?.type === "element" ? code.properties.className : undefined
  const language = Array.isArray(classes)
    ? classes.find((value) => typeof value === "string" && value.startsWith("language-"))?.toString().slice(9)
    : undefined
  const { status, copy } = useCodeCopy(text)
  const diagram = useMermaid(text, language === "mermaid")

  return (
    <div className="narrative-code-block">
      <div className="narrative-code-toolbar">
        <span>{language || t("markdown.plainText", "text")}</span>
        <button type="button" onClick={copy} disabled={status === "copying"} aria-label={t("markdown.copyCode", "Copy code")}>
          {status === "copying" ? t("markdown.copying", "Copying…") : t("markdown.copy", "Copy")}
        </button>
        <span className="narrative-code-copy-status" role="status">
          {status === "copied" ? t("markdown.copied", "Copied!") : status === "failed" ? t("markdown.copyFailed", "Copy failed · select code to copy manually") : ""}
        </span>
      </div>
      {language === "mermaid" ? (
        <>
          {diagram?.status === "ready" ? (
            <div className="narrative-mermaid" aria-label={t("markdown.mermaidDiagram", "Mermaid diagram")} dangerouslySetInnerHTML={{ __html: diagram.html }} />
          ) : (
            <p className="narrative-mermaid-status" role="status">
              {diagram?.status === "failed" ? t("markdown.diagramUnavailable", "Diagram unavailable · source shown below") : t("markdown.loadingDiagram", "Loading diagram…")}
            </p>
          )}
          <details open={diagram?.status !== "ready"}>
            <summary className="narrative-mermaid-source">{t("markdown.diagramSource", "Diagram source")}</summary>
            <pre>{children}</pre>
          </details>
        </>
      ) : <pre>{children}</pre>}
    </div>
  )
}
