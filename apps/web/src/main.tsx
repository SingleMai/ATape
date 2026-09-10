import { RegistryProvider } from "@effect/atom-react"
import { RouterProvider } from "@tanstack/react-router"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { router } from "./router"
import { initializeWebI18n, resolveWebLocale } from "./i18n"
import "@atape/ui/styles.css"
import "./styles.css"
import "./workspace.css"
import "./settings.css"
import "./overview.css"

const root = document.getElementById("root")

if (root === null) {
  throw new Error("ATape root element was not found.")
}

initializeWebI18n(resolveWebLocale())

createRoot(root).render(
  <StrictMode>
    <RegistryProvider>
      <RouterProvider router={router} />
    </RegistryProvider>
  </StrictMode>
)
