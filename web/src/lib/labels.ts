const TASK_LABELS: Record<string, string> = {
  Deploy: "Deploy cluster",
  Upgrade: "Upgrade",
  AddNode: "Add nodes",
  DeleteNode: "Remove node",
  Destory: "Destroy cluster",
  Setting: "Change settings",
  Rebalance: "Rebalance",
  Archive: "Archive",
}

export function taskLabel(option: string) {
  return TASK_LABELS[option] ?? option
}
