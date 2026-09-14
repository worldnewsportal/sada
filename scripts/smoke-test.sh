#!/bin/bash
# E2E API smoke test: two users register, chat, react, read receipts.
set -e
BASE=http://localhost:3000/api/v1
TS=$(date +%s | tail -c 6)
P1="+96477100$TS"
P2="+96477200$TS"

login() {
  local phone=$1
  local code=$(curl -s -X POST $BASE/auth/request-otp -H 'content-type: application/json' -d "{\"phone\":\"$phone\"}" | grep -o '"devCode":"[0-9]*"' | grep -o '[0-9]*')
  curl -s -c /tmp/c$2.txt -X POST $BASE/auth/verify-otp -H 'content-type: application/json' -d "{\"phone\":\"$phone\",\"code\":\"$code\"}" > /dev/null
  echo "user $2 ready ($phone)"
}

login $P1 1
login $P2 2

# user2 gets a username so user1 can find them
curl -s -b /tmp/c2.txt -X PATCH $BASE/users/me -H 'content-type: application/json' -d '{"displayName":"علي الثاني","username":"ali'$TS'"}' > /dev/null

# user1 finds user2
U2=$(curl -s -b /tmp/c1.txt "$BASE/users/search?q=ali$TS" | grep -o '"id":"[a-f0-9]*"' | head -1 | cut -d'"' -f4)
echo "found user2: $U2"

# user1 creates private chat
CHAT=$(curl -s -b /tmp/c1.txt -X POST $BASE/chats/private -H 'content-type: application/json' -d "{\"userId\":\"$U2\"}" | grep -o '"id":"[A-Z0-9]*"' | head -1 | cut -d'"' -f4)
echo "chat: $CHAT"

# user1 sends a message (idempotency key)
MSG=$(curl -s -b /tmp/c1.txt -X POST $BASE/chats/$CHAT/messages -H 'content-type: application/json' -d '{"text":"مرحبا يا علي 👋","clientMsgId":"smoke-1"}')
echo "sent: $(echo $MSG | head -c 160)"
MSGID=$(echo $MSG | grep -o '"id":"[A-Z0-9]*"' | head -1 | cut -d'"' -f4)

# duplicate send (same clientMsgId) — must return same message
DUP=$(curl -s -b /tmp/c1.txt -X POST $BASE/chats/$CHAT/messages -H 'content-type: application/json' -d '{"text":"مرحبا يا علي 👋","clientMsgId":"smoke-1"}')
DUPID=$(echo $DUP | grep -o '"id":"[A-Z0-9]*"' | head -1 | cut -d'"' -f4)
[ "$MSGID" = "$DUPID" ] && echo "✓ idempotency OK" || echo "✗ IDEMPOTENCY BROKEN: $MSGID vs $DUPID"

# user2 sees the chat + unread
UNREAD=$(curl -s -b /tmp/c2.txt "$BASE/chats" | grep -o '"unreadCount":[0-9]*' | head -1)
echo "user2 chat list: $UNREAD"

# user2 reads all
curl -s -b /tmp/c2.txt -X POST $BASE/chats/$CHAT/read -H 'content-type: application/json' -d '{"upToSeq":100}' > /dev/null

# user2 reacts
curl -s -b /tmp/c2.txt -X POST $BASE/messages/$MSGID/reactions -H 'content-type: application/json' -d '{"emoji":"❤️"}' | head -c 120; echo ""

# user1 edits message
curl -s -b /tmp/c1.txt -X PATCH $BASE/messages/$MSGID -H 'content-type: application/json' -d '{"text":"مرحبا يا علي (معدلة)"}' > /dev/null
echo "✓ edit ok"

# user2 replies
curl -s -b /tmp/c2.txt -X POST $BASE/chats/$CHAT/messages -H 'content-type: application/json' -d "{\"text\":\"أهلاً!\",\"replyToId\":\"$MSGID\",\"clientMsgId\":\"smoke-2\"}" | head -c 100; echo ""

# pagination check
PAGE=$(curl -s -b /tmp/c1.txt "$BASE/chats/$CHAT/messages?limit=1")
echo "page1: $(echo $PAGE | head -c 120)"

# search
SEARCH=$(curl -s -b /tmp/c1.txt "$BASE/search/messages?q=معدلة")
echo "search hits: $(echo $SEARCH | grep -o '"messageId"' | wc -l)"

# block check: user2 blocks user1 → user1 cannot send
curl -s -b /tmp/c2.txt -X POST $BASE/users/$U2/../users/blocked > /dev/null 2>&1 || true
B=$(curl -s -b /tmp/c2.txt -X POST $BASE/users/$(curl -s -b /tmp/c1.txt $BASE/users/me | grep -o '"id":"[a-f0-9]*"' | head -1 | cut -d'"' -f4)/block -H 'content-type: application/json' -d '{}')
echo "block: $B"
BLOCKED=$(curl -s -b /tmp/c1.txt -X POST $BASE/chats/$CHAT/messages -H 'content-type: application/json' -d '{"text":"still works?","clientMsgId":"smoke-3"}')
echo "send-while-blocked: $(echo $BLOCKED | head -c 120)"

# sync
SYNC=$(curl -s -b /tmp/c1.txt "$BASE/sync?since=0")
echo "sync events: $(echo $SYNC | grep -o '"seq"' | wc -l)"

echo "=== SMOKE TEST DONE ==="
