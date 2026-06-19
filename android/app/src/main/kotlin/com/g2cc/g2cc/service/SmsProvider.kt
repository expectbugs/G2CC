package com.g2cc.g2cc.service

import android.content.Context
import android.net.Uri
import android.provider.ContactsContract
import android.provider.Telephony
import com.g2cc.g2cc.harness.DiagLog
import com.g2cc.g2cc.net.SmsMessage
import com.g2cc.g2cc.net.SmsThread

/**
 * Phase 4b — read SMS from the Telephony provider (needs READ_SMS +
 * READ_CONTACTS, one-time home grants). Thread list + one thread's messages,
 * paginated, with contact-name resolution.
 *
 * SCOPE (v1): SMS only. MMS image parts are NOT decoded here yet (the server
 * already renders `imageB64` if present — MMS is a follow-up that fills it).
 * Sending is SmsManager.sendTextMessage (ConnectionService.handleSmsSend).
 *
 * Discipline: a denied/failed provider read returns the reply's `error` LOUDLY
 * (never a silent empty list passed off as "no messages").
 */
object SmsProvider {
    private const val PAGE = 30   // messages per thread page

    data class ThreadsResult(val threads: List<SmsThread>, val total: Int, val error: String?)
    data class ThreadResult(val threadId: String, val name: String, val address: String, val messages: List<SmsMessage>, val page: Int, val totalPages: Int, val error: String?)

    fun queryThreads(ctx: Context, offset: Int, limit: Int): ThreadsResult {
        return try {
            // newest message per thread_id → one SmsThread each
            val threads = LinkedHashMap<String, SmsThread>()
            val cols = arrayOf(Telephony.Sms.THREAD_ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.READ)
            ctx.contentResolver.query(Telephony.Sms.CONTENT_URI, cols, null, null, "${Telephony.Sms.DATE} DESC")?.use { c ->
                val iTid = c.getColumnIndexOrThrow(Telephony.Sms.THREAD_ID)
                val iAddr = c.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
                val iBody = c.getColumnIndexOrThrow(Telephony.Sms.BODY)
                val iDate = c.getColumnIndexOrThrow(Telephony.Sms.DATE)
                val iRead = c.getColumnIndexOrThrow(Telephony.Sms.READ)
                while (c.moveToNext()) {
                    val tid = c.getString(iTid) ?: continue
                    if (threads.containsKey(tid)) continue   // rows are DATE DESC → first = newest
                    val addr = c.getString(iAddr) ?: ""
                    threads[tid] = SmsThread(
                        id = tid, name = resolveName(ctx, addr), address = addr,
                        snippet = (c.getString(iBody) ?: "").replace('\n', ' ').take(80),
                        unread = c.getInt(iRead) == 0, tsMs = c.getLong(iDate),
                    )
                }
            } ?: return ThreadsResult(emptyList(), 0, "SMS provider returned no cursor")
            val all = threads.values.sortedByDescending { it.tsMs }
            ThreadsResult(all.drop(offset).take(limit), all.size, null)
        } catch (e: SecurityException) {
            DiagLog.log("sms", "threads query DENIED: $e")
            ThreadsResult(emptyList(), 0, "READ_SMS / READ_CONTACTS not granted — grant it in the app, then Reload")
        } catch (e: Exception) {
            DiagLog.log("sms", "threads query failed: $e")
            ThreadsResult(emptyList(), 0, "thread list failed: ${e.message}")
        }
    }

    fun queryThread(ctx: Context, threadId: String, page: Int): ThreadResult {
        return try {
            val msgs = ArrayList<SmsMessage>()
            var address = ""
            val cols = arrayOf(Telephony.Sms._ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE)
            ctx.contentResolver.query(Telephony.Sms.CONTENT_URI, cols, "${Telephony.Sms.THREAD_ID} = ?", arrayOf(threadId), "${Telephony.Sms.DATE} ASC")?.use { c ->
                val iId = c.getColumnIndexOrThrow(Telephony.Sms._ID)
                val iAddr = c.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
                val iBody = c.getColumnIndexOrThrow(Telephony.Sms.BODY)
                val iDate = c.getColumnIndexOrThrow(Telephony.Sms.DATE)
                val iType = c.getColumnIndexOrThrow(Telephony.Sms.TYPE)
                while (c.moveToNext()) {
                    val addr = c.getString(iAddr); if (addr != null && address.isEmpty()) address = addr
                    msgs.add(SmsMessage(
                        id = c.getString(iId) ?: "", body = c.getString(iBody) ?: "",
                        incoming = c.getInt(iType) == Telephony.Sms.MESSAGE_TYPE_INBOX, tsMs = c.getLong(iDate),
                    ))
                }
            } ?: return ThreadResult(threadId, "", "", emptyList(), 0, 1, "SMS provider returned no cursor")
            val totalPages = maxOf(1, (msgs.size + PAGE - 1) / PAGE)
            val p = page.coerceIn(0, totalPages - 1)
            // page 0 = NEWEST block (most recent messages); within a page,
            // oldest→newest (newest last). The server's Next(newer)=page-1 /
            // Prev(older)=page+1 navigation matches this.
            val end = msgs.size - p * PAGE
            val start = maxOf(0, end - PAGE)
            val pageMsgs = if (msgs.isEmpty()) emptyList() else msgs.subList(start, end).toList()
            val name = if (address.isNotEmpty()) resolveName(ctx, address) else ""
            ThreadResult(threadId, name.ifEmpty { address }, address, pageMsgs, p, totalPages, null)
        } catch (e: SecurityException) {
            DiagLog.log("sms", "thread query DENIED: $e")
            ThreadResult(threadId, "", "", emptyList(), 0, 1, "READ_SMS not granted")
        } catch (e: Exception) {
            DiagLog.log("sms", "thread query failed: $e")
            ThreadResult(threadId, "", "", emptyList(), 0, 1, "thread query failed: ${e.message}")
        }
    }

    // ConcurrentHashMap (not HashMap): two SMS requests run as separate
    // Dispatchers.IO coroutines and both call resolveName → concurrent map
    // mutation (matches NotifyListener's imgJobs fix).
    private val nameCache = java.util.concurrent.ConcurrentHashMap<String, String>()
    fun resolveName(ctx: Context, address: String): String {   // also used by NotifyListener for the RemoteInput-reply match
        if (address.isBlank()) return address
        nameCache[address]?.let { return it }
        val resolved = try {
            val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(address))
            ctx.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        } catch (e: Exception) {
            DiagLog.log("sms", "name lookup failed for $address: $e"); null
        } ?: address
        nameCache[address] = resolved
        return resolved
    }
}
