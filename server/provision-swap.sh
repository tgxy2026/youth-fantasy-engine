#!/usr/bin/env bash
# 一次性初始化脚本：2 GB swap + 降低 swappiness
# 幂等：重复执行不会重复创建或重复写 fstab
set -u

if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  echo "SWAP_CREATED"
else
  echo "SWAP_EXISTS"
fi

grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 物理内存还有余量时不要急着用 swap（1.7G 机器上默认 60 会让正常流程变慢）
sysctl -w vm.swappiness=10 >/dev/null
grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf

echo "--- free ---"
free -m
echo "--- swapon ---"
swapon --show
echo "--- fstab ---"
grep swapfile /etc/fstab
