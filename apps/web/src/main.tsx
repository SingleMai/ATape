import { RegistryProvider } from "@effect/atom-react"
import { RouterProvider } from "@tanstack/react-router"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { router } from "./router"
import "@atape/ui/styles.css"
import "./styles.css"

const root = document.getElementById("root")

if (root === null) {
  throw new Error("ATape root element was not found.")
}

createRoot(root).render(
  <StrictMode>
    <RegistryProvider>
      <RouterProvider router={router} />
    </RegistryProvider>
  </StrictMode>
)
