import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate, useRouteContext } from "@tanstack/react-router"
import {
  ChevronsUpDownIcon,
  DatabaseIcon,
  CpuIcon,
  HardDriveIcon,
  KeyRoundIcon,
  ListChecksIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PackageIcon,
  ServerIcon,
  SunIcon,
  UsersIcon,
} from "lucide-react"
import { useState } from "react"

import { logout } from "@/api/client"
import { clusterListQuery } from "@/api/queries"
import { ChangePasswordDialog } from "@/components/app/change-password-dialog"
import { useTheme } from "@/components/theme-provider"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar"

export function AppSidebar() {
  const { session } = useRouteContext({ from: "/_app" })
  const clusters = useQuery(clusterListQuery())
  const isAdmin = session.policy === "admin"

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/clusters" />}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <DatabaseIcon className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">ckman</span>
                <span className="truncate text-xs text-muted-foreground">
                  ClickHouse manager
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Manage</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <NavButton
                to="/clusters"
                icon={<ServerIcon />}
                label="Clusters"
              />
              {clusters.data && clusters.data.length > 0 && (
                <SidebarMenuSub>
                  {clusters.data.map((c) => (
                    <SidebarMenuSubItem key={c.cluster}>
                      <SidebarMenuSubButton
                        render={
                          <Link
                            to="/clusters/$cluster"
                            params={{ cluster: c.cluster }}
                            activeProps={{ "data-active": true }}
                          />
                        }
                      >
                        <span className="truncate">{c.cluster}</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  ))}
                </SidebarMenuSub>
              )}
            </SidebarMenuItem>
            <SidebarMenuItem>
              <NavButton to="/machines" icon={<CpuIcon />} label="Machines" />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <NavButton to="/tasks" icon={<ListChecksIcon />} label="Tasks" />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <NavButton
                to="/packages"
                icon={<PackageIcon />}
                label="Packages"
              />
            </SidebarMenuItem>
            {isAdmin && (
              <>
                <SidebarMenuItem>
                  <NavButton
                    to="/storage"
                    icon={<HardDriveIcon />}
                    label="Storage"
                  />
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <NavButton to="/users" icon={<UsersIcon />} label="Users" />
                </SidebarMenuItem>
              </>
            )}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <UserMenu username={session.username} policy={session.policy} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

function NavButton({
  to,
  icon,
  label,
}: {
  to: "/clusters" | "/machines" | "/tasks" | "/packages" | "/storage" | "/users"
  icon: React.ReactNode
  label: string
}) {
  return (
    <SidebarMenuButton
      tooltip={label}
      render={<Link to={to} activeProps={{ "data-active": true }} />}
    >
      {icon}
      <span>{label}</span>
    </SidebarMenuButton>
  )
}

function UserMenu({ username, policy }: { username: string; policy: string }) {
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()
  const [passwordOpen, setPasswordOpen] = useState(false)

  async function signOut() {
    await logout().catch(() => {})
    await navigate({ to: "/login" })
  }

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-md bg-muted text-sm font-medium uppercase">
                {username.slice(0, 1)}
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{username}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {policy}
                </span>
              </div>
              <ChevronsUpDownIcon className="ml-auto size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="min-w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Theme</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={theme}
                  onValueChange={(v) => setTheme(v as typeof theme)}
                >
                  <DropdownMenuRadioItem value="light">
                    <SunIcon /> Light
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    <MoonIcon /> Dark
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">
                    <MonitorIcon /> System
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setPasswordOpen(true)}>
                <KeyRoundIcon /> Change password
              </DropdownMenuItem>
              <DropdownMenuItem onClick={signOut}>
                <LogOutIcon /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
      <ChangePasswordDialog
        open={passwordOpen}
        onOpenChange={setPasswordOpen}
      />
    </>
  )
}
