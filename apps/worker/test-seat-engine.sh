#!/bin/bash
set -o pipefail

TOKEN=$1

if [ -z "$TOKEN" ]; then
  echo "Usage: $0 <TOKEN>"
  exit 1
fi

BASE_URL="https://event-booking-worker.aditya29.workers.dev/trpc"
FAILURES=0
TOTAL=0

# Helper functions
post() {
  local procedure=$1
  local body=$2
  curl -s -X POST "$BASE_URL/$procedure" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body"
}

get() {
  local procedure=$1
  local params=$2
  curl -s -X GET "$BASE_URL/$procedure?input=$params" \
    -H "Authorization: Bearer $TOKEN"
}

assert_contains() {
  local test_name=$1
  local response=$2
  local expected=$3
  TOTAL=$((TOTAL + 1))
  
  if echo "$response" | grep -q "$expected"; then
    echo "PASS: $test_name"
  else
    echo "FAIL: $test_name"
    echo "  Expected to find: '$expected'"
    echo "  Actual response: $response"
    FAILURES=$((FAILURES + 1))
  fi
}

assert_not_contains() {
  local test_name=$1
  local response=$2
  local expected=$3
  TOTAL=$((TOTAL + 1))
  
  if echo "$response" | grep -q "$expected"; then
    echo "FAIL: $test_name"
    echo "  Expected NOT to find: '$expected'"
    echo "  Actual response: $response"
    FAILURES=$((FAILURES + 1))
  else
    echo "PASS: $test_name"
  fi
}

echo "=== TEST 1: ensureAttendee — creates or returns attendee ==="
res=$(post "ensureAttendee" "{}")
assert_contains "ensureAttendee returns userId" "$res" "userId"
assert_not_contains "ensureAttendee has no error" "$res" "error"
sleep 1

echo "=== TEST 2: reserveSeat — returns holdId ==="
res=$(post "reserveSeat" '{"eventId":"day7-test-event","seatCount":1}')
assert_contains "reserveSeat returns reservationId" "$res" "reservationId"
assert_not_contains "reserveSeat has no error" "$res" "error"
HOLD_ID=$(echo "$res" | jq -r '.result.data.reservationId')
sleep 1

echo "=== TEST 3: confirmBooking — writes D1 booking row ==="
res=$(post "confirmBooking" "{\"holdId\":\"$HOLD_ID\",\"eventId\":\"day7-test-event\"}")
assert_contains "confirmBooking returns confirmed" "$res" "confirmed"
assert_contains "confirmBooking returns attendeeId" "$res" "attendeeId"
assert_not_contains "confirmBooking has no error" "$res" "error"
sleep 1

echo "=== TEST 4: confirmBooking — double confirm returns CONFLICT ==="
res=$(post "confirmBooking" "{\"holdId\":\"$HOLD_ID\",\"eventId\":\"day7-test-event\"}")
assert_contains "confirmBooking double confirm returns CONFLICT" "$res" "CONFLICT"
assert_contains "confirmBooking double confirm returns HOLD_ALREADY_USED" "$res" "HOLD_ALREADY_USED"
sleep 1

echo "=== TEST 5: releaseBooking — returns released:true ==="
res=$(post "reserveSeat" '{"eventId":"day7-test-event","seatCount":1}')
NEW_HOLD_ID=$(echo "$res" | jq -r '.result.data.reservationId')
sleep 1

res=$(post "releaseBooking" "{\"holdId\":\"$NEW_HOLD_ID\",\"eventId\":\"day7-test-event\"}")
assert_contains "releaseBooking returns released" "$res" "released"
assert_not_contains "releaseBooking has no error" "$res" "error"
sleep 1

echo "=== TEST 6: releaseBooking — double release is silent no-op ==="
res=$(post "releaseBooking" "{\"holdId\":\"$NEW_HOLD_ID\",\"eventId\":\"day7-test-event\"}")
assert_contains "releaseBooking double release returns released" "$res" "released"
assert_not_contains "releaseBooking double release has no error" "$res" "error"
sleep 1

echo "=== TEST 7: confirmBooking — HOLD_NOT_FOUND for fake holdId ==="
res=$(post "confirmBooking" '{"holdId":"00000000-0000-0000-0000-000000000000","eventId":"day7-test-event"}')
assert_contains "confirmBooking fake hold returns NOT_FOUND" "$res" "NOT_FOUND"
assert_contains "confirmBooking fake hold returns HOLD_NOT_FOUND" "$res" "HOLD_NOT_FOUND"
sleep 1

echo "=== TEST 8: seat count consistency after confirms and releases ==="
res=$(get "getAvailableSeats" "%7B%22eventId%22%3A%22day7-test-event%22%7D")
assert_not_contains "getAvailableSeats has no error" "$res" "error"
COUNT=$(echo "$res" | jq -r '.result.data')
TOTAL=$((TOTAL + 1))
if [ "$COUNT" != "null" ] && [ -n "$COUNT" ] && [[ "$COUNT" =~ ^[0-9]+$ ]]; then
  echo "PASS: getAvailableSeats returned a number"
else
  echo "FAIL: getAvailableSeats did not return a number"
  echo "  Actual response: $res"
  FAILURES=$((FAILURES + 1))
fi
echo "Available seats: $COUNT"
sleep 1

echo "=== TEST 9: reserveSeat — sold out returns error when no seats left ==="
res=$(post "reserveSeat" '{"eventId":"race-test-event","seatCount":1}')
if echo "$res" | grep -q "reservationId"; then
  echo "SKIP — race-test-event has seats remaining, cannot test sold-out path"
else
  assert_contains "reserveSeat sold out has error" "$res" "error"
  assert_contains "reserveSeat sold out error says seats available" "$res" "seats available"
fi

echo ""
echo "=== SUMMARY ==="
PASSED=$((TOTAL - FAILURES))
echo "$PASSED/$TOTAL tests passed"

if [ $FAILURES -gt 0 ]; then
  exit 1
fi
exit 0
