import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"

import { getSession } from "@/api/client"
import { AppSidebar } from "@/components/app/app-sidebar"
import { Separator } from "@/components/ui/separator"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"

export const Route = createFileRoute("/_app")({
  beforeLoad: ({ location }) => {
    const session = getSession()
    if (!session) {
      throw redirect({ to: "/login", search: { redirect: location.href } })
    }
    return { session }
  },
  component: AppLayout,
})

function AppLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 md:hidden">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <span className="text-sm font-medium">ckman</span>
        </header>
        <div className="flex min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
