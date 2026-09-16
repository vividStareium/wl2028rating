const CONFIG = {
    INITIAL_RATING: 1500,
    ABSENT_PENALTY: 0,
    DATA_URL: 'data/ratings.csv',
    GOLD_CROWN_MIN_PARTICIPANTS: 20,
    GOLD_MEDAL_RATIO: 0.10,
    SILVER_MEDAL_RATIO: 0.30,
    BRONZE_MEDAL_RATIO: 0.60
};

class RatingCalculator {
    static getEloWinProbability(ra, rb) { return 1.0 / (1 + Math.pow(10, (rb - ra) / 400.0)); }
    static getSeed(entities, rating) {
        let result = 1;
        for (const other of entities) result += this.getEloWinProbability(other.rating, rating);
        return result;
    }
    static getRatingToRank(entities, rank) {
        let left = 1, right = 8000;
        while (right - left > 1) {
            const mid = Math.floor((left + right) / 2);
            if (this.getSeed(entities, mid) < rank) right = mid; else left = mid;
        }
        return left;
    }
    static calculateDeltas(participants) {
        if (participants.length === 0) return;
        const teamMap = new Map();
        for (const p of participants) {
            if (!teamMap.has(p.teamId)) teamMap.set(p.teamId, []);
            teamMap.get(p.teamId).push(p);
        }
        const teams = Array.from(teamMap.values()).map(members => {
            let sumExp = 0;
            for (const m of members) sumExp += Math.pow(10, m.rating / 800.0);
            return { members, rating:800 * Math.log10(sumExp), rank:members[0].rank, seed:0, needRating:0, delta:0 };
        });
        for (const a of teams) {
            a.seed = 1;
            for (const b of teams) if (a !== b) a.seed += this.getEloWinProbability(b.rating, a.rating);
        }
        for (const t of teams) {
            const midRank = Math.sqrt(t.rank * t.seed);
            t.needRating = this.getRatingToRank(teams, midRank);
            t.delta = Math.floor((t.needRating - t.rating) / 2);
        }
        teams.sort((a,b) => b.rating - a.rating);
        let sum = 0;
        for (const t of teams) sum += t.delta;
        const inc = Math.floor(-sum / teams.length);
        for (const t of teams) t.delta += inc;
        const CENTER = 1500, K = 45000;
        for (const t of teams) {
            const dist = CENTER - t.rating;
            t.delta += Math.round((dist * Math.abs(dist)) / K);
            const names = t.members.map(x => x.originalUser.name);
            for (const m of t.members) {
                m.delta = t.delta;
                m.teamRating = Math.round(t.rating);
                m.seed = t.seed;
                m.teammates = names.filter(name => name !== m.originalUser.name);
            }
        }
    }
}

class App {
    constructor() {
        this.users = [];
        this.contestNames = [];
        this.contestParticipantCounts = [];
        window.addEventListener('hashchange', () => this.syncPageFromHash());
    }

    async init() {
        this.syncPageFromHash();
        try {
            const csv = await this.loadData();
            this.processData(csv);
            this.renderTable();
            this.renderMedalTable();
            this.renderChart();
        } catch (error) {
            console.error(error);
            this.showLoadError(error);
        }
    }

    async loadData() {
        const response = await fetch(CONFIG.DATA_URL, { cache:'no-store' });
        if (!response.ok) throw new Error(`读取 ${CONFIG.DATA_URL} 失败：HTTP ${response.status}`);
        return response.text();
    }

    showLoadError(error) {
        const el = document.getElementById('load-error');
        el.hidden = false;
        el.textContent = `数据加载失败：${error.message}。如果你是直接双击 index.html 打开的，请通过 GitHub Pages 或本地 HTTP 服务器访问。`;
        document.getElementById('table-container').innerHTML = '<p class="loading">无法加载排名数据</p>';
        document.getElementById('medal-table-container').innerHTML = '<p class="loading">无法加载奖牌数据</p>';
    }

    parseRankCell(value) {
        const val = String(value ?? '').trim();
        if (val === '-1') return { rank:-1, teamId:null };
        if (val === '0' || val === '') return { rank:0, teamId:null };
        const match = val.match(/^(\d+)(.*)$/);
        if (!match) return { rank:0, teamId:null };
        const rank = parseInt(match[1], 10);
        let teamId = match[2].trim();
        if (teamId.startsWith(':') || teamId.startsWith('-') || teamId.startsWith('_')) teamId = teamId.substring(1).trim();
        return { rank, teamId:teamId || null };
    }

    processData(csvString) {
        this.users = [];
        const normalized = csvString.replace(/\t/g, ',').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const rows = normalized.trim().split('\n').filter(r => r.trim()).map(row => row.split(',').map(v => v.trim()));
        if (!rows.length) throw new Error('ratings.csv 为空');
        this.contestNames = rows[0].slice(1);
        const expectedColumns = this.contestNames.length + 1;

        for (let i=1; i<rows.length; i++) {
            const cols = rows[i];
            if (!cols[0]) continue;
            if (cols.length !== expectedColumns) throw new Error(`ratings.csv 第 ${i + 1} 行列数为 ${cols.length}，应为 ${expectedColumns}`);
            this.users.push({
                name:cols[0], currentRating:CONFIG.INITIAL_RATING,
                ranks:cols.slice(1).map(v => this.parseRankCell(v)),
                history:[], isActive:true, currentAbsence:0, participatedCount:0,
                awards:{ goldCrown:0, silverCrown:0, goldMedal:0, silverMedal:0, bronzeMedal:0 }
            });
        }

        this.contestParticipantCounts = this.contestNames.map((_, cIdx) =>
            this.users.reduce((count, user) => count + (user.ranks[cIdx].rank > 0 ? 1 : 0), 0)
        );

        this.contestNames.forEach((_, cIdx) => {
            const parts = [], absentees = [];
            for (const user of this.users) {
                const rObj = user.ranks[cIdx];
                if (rObj.rank > 0) {
                    parts.push({ originalUser:user, rating:user.currentRating, rank:rObj.rank, teamId:rObj.teamId || user.name, delta:0 });
                } else if (rObj.rank === -1) {
                    absentees.push(user);
                } else {
                    user.history.push({ rating:user.currentRating, delta:0, rank:0, teamId:null });
                }
            }

            RatingCalculator.calculateDeltas(parts);
            for (const p of parts) {
                const user = p.originalUser;
                let newcomerMultiplier = 1.0;
                if (user.participatedCount === 0) newcomerMultiplier = 2.0;
                else if (user.participatedCount === 1) newcomerMultiplier = 1.5;
                else if (user.participatedCount === 2) newcomerMultiplier = 1.3;
                else if (user.participatedCount === 3) newcomerMultiplier = 1.2;
                else if (user.participatedCount === 4) newcomerMultiplier = 1.1;

                let dormancyMultiplier = 1.0;
                if (user.currentAbsence > 2) {
                    dormancyMultiplier = user.currentAbsence >= 20 ? 2.0 : 1.0 + Math.pow(user.currentAbsence - 2, 2) / 324.0;
                }
                const multiplier = Math.max(newcomerMultiplier, dormancyMultiplier);
                const mulType = multiplier > 1.0 ? (newcomerMultiplier >= dormancyMultiplier ? '新手定级' : '休眠复出') : '无';
                const finalDelta = Math.round(p.delta * multiplier);
                user.currentRating += finalDelta;
                user.history.push({
                    rating:user.currentRating, delta:finalDelta, rank:p.rank,
                    teamId:p.teamId === user.name ? null : p.teamId,
                    teamRating:p.teamRating, seed:p.seed, teammates:p.teammates,
                    multiplierUsed:multiplier, mulType
                });
                user.currentAbsence = 0;
                user.participatedCount += 1;
            }

            for (const user of absentees) {
                user.currentRating += CONFIG.ABSENT_PENALTY;
                user.currentAbsence += 1;
                user.history.push({ rating:user.currentRating, delta:CONFIG.ABSENT_PENALTY, rank:-1, teamId:null });
            }
        });

        for (const user of this.users) {
            let consecutiveAbsence = 0;
            for (let i=user.ranks.length - 1; i>=0; i--) {
                if (user.ranks[i].rank <= 0) consecutiveAbsence++; else break;
            }
            user.isActive = user.ranks.some(r => r.rank > 0) && consecutiveAbsence < 2;
        }
        this.calculateAwards();
    }

    calculateAwards() {
        for (const user of this.users) user.awards = { goldCrown:0, silverCrown:0, goldMedal:0, silverMedal:0, bronzeMedal:0 };
        this.contestNames.forEach((_, cIdx) => {
            const n = this.contestParticipantCounts[cIdx];
            if (!n) return;
            const goldLine = Math.ceil(n * CONFIG.GOLD_MEDAL_RATIO);
            const silverLine = Math.ceil(n * CONFIG.SILVER_MEDAL_RATIO);
            const bronzeLine = Math.ceil(n * CONFIG.BRONZE_MEDAL_RATIO);
            for (const user of this.users) {
                const rank = user.ranks[cIdx].rank;
                if (rank <= 0) continue;
                if (rank === 1) {
                    if (n >= CONFIG.GOLD_CROWN_MIN_PARTICIPANTS) user.awards.goldCrown++;
                    else user.awards.silverCrown++;
                } else if (rank <= goldLine) user.awards.goldMedal++;
                else if (rank <= silverLine) user.awards.silverMedal++;
                else if (rank <= bronzeLine) user.awards.bronzeMedal++;
            }
        });
    }

    getColorClass(rating) {
        if (rating < 1200) return 'user-newbie';
        if (rating < 1400) return 'user-pupil';
        if (rating < 1600) return 'user-specialist';
        if (rating < 1900) return 'user-expert';
        if (rating < 2100) return 'user-candidate-master';
        if (rating < 2400) return 'user-master';
        if (rating < 3000) return 'user-grandmaster';
        return 'user-legendary';
    }

    getVisibleUsers() {
        const showInactive = document.getElementById('toggleInactive').checked;
        return (showInactive ? [...this.users] : this.users.filter(u => u.isActive))
            .sort((a,b) => b.currentRating - a.currentRating || a.name.localeCompare(b.name));
    }

    getNameAchievement(user) {
        if (user.awards.goldCrown > 0) return '<span class="achievement-badge" title="至少获得过一次金冠">👑</span>';
        if (user.awards.silverCrown > 0) return '<span class="achievement-badge silver-crown" title="至少获得过一次银冠">👑</span>';
        if (user.awards.goldMedal > 0) return '<span class="achievement-badge" title="至少获得过一次金牌">🥇</span>';
        return '';
    }

    renderTable() {
        const visibleUsers = this.getVisibleUsers();
        let html = `<table id="rating-table-data"><thead><tr><th>排名</th><th>姓名</th><th>当前分</th>${this.contestNames.map(n => `<th>${n}</th>`).join('')}</tr></thead><tbody>`;
        visibleUsers.forEach((user, idx) => {
            const rowClass = user.isActive ? '' : 'inactive-row';
            const inactiveSuffix = user.isActive ? '' : ' <span style="font-size:12px;color:#999;">(休眠)</span>';
            html += `<tr class="${rowClass}"><td>${idx + 1}</td><td style="text-align:left"><span class="${this.getColorClass(user.currentRating)}">${user.name}</span>${this.getNameAchievement(user)}${inactiveSuffix}</td><td style="font-weight:bold;background:${user.isActive ? '#f8f9fa' : '#fcfcfc'};">${user.currentRating}</td>`;
            for (const h of user.history) {
                if (h.rank === -1) {
                    const penaltyText = h.delta !== 0 ? ` <small>(${h.delta})</small>` : '';
                    html += `<td><span style="color:#d9534f;font-size:.9em;">缺席${penaltyText}</span></td>`;
                } else if (h.rank === 0) {
                    html += '<td><span class="delta-zero">-</span></td>';
                } else {
                    const dClass = h.delta >= 0 ? 'delta-pos' : 'delta-neg';
                    const sign = h.delta >= 0 ? '+' : '';
                    const teamTag = h.teamId ? `<span class="team-tag">${h.teamId}</span>` : '';
                    let tooltip = `预计排名: ${h.seed ? h.seed.toFixed(2) : '-'}`;
                    if (h.teamId) {
                        tooltip += `\n等效 Rating: ${h.teamRating}`;
                        tooltip += `\n队友: ${h.teammates && h.teammates.length ? h.teammates.join(', ') : '无'}`;
                    }
                    if (h.multiplierUsed > 1.0) tooltip += `\n${h.mulType}倍率: ${h.multiplierUsed.toFixed(2)}x`;
                    html += `<td title="${tooltip}" style="cursor:help;"><span class="rank-badge">#${h.rank}</span>${teamTag}<br><span class="${this.getColorClass(h.rating)} rating-val">${h.rating}</span><br><span class="${dClass}">(${sign}${h.delta})</span></td>`;
                }
            }
            html += '</tr>';
        });
        document.getElementById('table-container').innerHTML = html + '</tbody></table>';
    }

    renderMedalTable() {
        const keys = ['goldCrown','silverCrown','goldMedal','silverMedal','bronzeMedal'];
        const sorted = [...this.users].sort((a,b) => {
            for (const key of keys) if (a.awards[key] !== b.awards[key]) return b.awards[key] - a.awards[key];
            return b.currentRating - a.currentRating || a.name.localeCompare(b.name);
        });
        let html = '<table><thead><tr><th>排名</th><th>ID</th><th>👑 金冠</th><th>👑 银冠</th><th>🥇 金牌</th><th>🥈 银牌</th><th>🥉 铜牌</th></tr></thead><tbody>';
        sorted.forEach((user, idx) => {
            html += `<tr><td>${idx + 1}</td><td class="medal-name"><span class="${this.getColorClass(user.currentRating)}">${user.name}</span></td><td class="medal-count">${user.awards.goldCrown}</td><td class="medal-count">${user.awards.silverCrown}</td><td class="medal-count">${user.awards.goldMedal}</td><td class="medal-count">${user.awards.silverMedal}</td><td class="medal-count">${user.awards.bronzeMedal}</td></tr>`;
        });
        document.getElementById('medal-table-container').innerHTML = html + '</tbody></table>';
    }

    getDistinctColor(index, alpha=1.0) {
        const hue = (index * 137.508) % 360;
        return `hsla(${hue},70%,45%,${alpha})`;
    }

    renderChart() {
        if (typeof Chart === 'undefined') return;
        const visibleUsers = this.getVisibleUsers();
        const ctx = document.getElementById('ratingChart').getContext('2d');
        const datasets = visibleUsers.map((user, i) => {
            const color = this.getDistinctColor(i, user.isActive ? 1.0 : 0.4);
            return {
                label:user.name + (user.isActive ? '' : ' (休眠)'),
                data:[CONFIG.INITIAL_RATING, ...user.history.map(h => h.rating)],
                borderColor:color, backgroundColor:color,
                borderWidth:i < 3 ? 2.5 : (user.isActive ? 2 : 1),
                borderDash:user.isActive ? [] : [5,5], hidden:i >= 3,
                tension:.3, pointRadius:user.isActive ? 3 : 1,
                pointHoverRadius:6, hoverBorderWidth:4, hoverBorderColor:color, order:i
            };
        });
        if (window.myChartInstance) window.myChartInstance.destroy();
        window.myChartInstance = new Chart(ctx, {
            type:'line', data:{ labels:['初始', ...this.contestNames], datasets },
            options:{ responsive:true, maintainAspectRatio:false, interaction:{mode:'index',intersect:false}, plugins:{ legend:{position:'bottom',labels:{usePointStyle:true,padding:15,boxWidth:8,font:{size:11}}}, tooltip:{mode:'index',intersect:false,itemSort:(a,b)=>b.raw-a.raw} }, scales:{ y:{grid:{color:'#f0f0f0'}}, x:{grid:{display:false}} } }
        });
    }

    showPage(page, updateHash=true) {
        const target = page === 'medals' ? 'medals' : 'rating';
        document.querySelectorAll('.page-section').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
        document.getElementById(`page-${target}`).classList.add('active');
        document.getElementById(`nav-${target}`).classList.add('active');
        if (updateHash && location.hash !== `#${target}`) history.replaceState(null, '', `#${target}`);
    }

    syncPageFromHash() { this.showPage(location.hash === '#medals' ? 'medals' : 'rating', false); }
}

function exportToExcel() {
    const table = document.getElementById('rating-table-data');
    if (!table) return;
    const style = `<style>table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:5px;text-align:center;vertical-align:middle}th{background:#eee;font-weight:bold}.user-newbie{color:#808080;font-weight:bold}.user-pupil{color:#008000;font-weight:bold}.user-specialist{color:#03a89e;font-weight:bold}.user-expert{color:#0000ff;font-weight:bold}.user-candidate-master{color:#aa00aa;font-weight:bold}.user-master{color:#ff8c00;font-weight:bold}.user-grandmaster,.user-legendary{color:#ff0000;font-weight:bold}.delta-pos{color:#008000}.delta-neg{color:#888}.delta-zero{color:#ccc}.rank-badge{background:#666;color:#fff;border-radius:3px;padding:1px 3px;font-size:10px}.team-tag{color:#007bff;font-size:10px}.inactive-row{color:#999}</style>`;
    const fullHtml = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="UTF-8">${style}</head><body>${table.outerHTML}</body></html>`;
    const blob = new Blob([fullHtml], {type:'application/vnd.ms-excel'});
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `Rating排名_${new Date().toISOString().slice(0,10)}.xls`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
}

const app = new App();
window.app = app;
window.addEventListener('DOMContentLoaded', () => app.init());
