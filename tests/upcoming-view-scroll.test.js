/**
 * Regression guard for the "Upcoming view does not scroll" bug.
 *
 * #calendar-container is `overflow:hidden; display:flex; flex-direction:column`,
 * so each top-level view it hosts must supply its own scroll region:
 *   - .day-view-scroll : flex:1 + overflow-y:auto
 *   - .week-view       : flex:1 + overflow:auto
 *   - .month-view      : flex:1 + overflow:auto
 *   - .upcoming-view   : flex:1 + overflow-y:auto  <-- was missing, content clipped
 *
 * jsdom performs no layout, so real scroll height can't be asserted. Instead we
 * lock the CSS contract: the Upcoming container must grow to fill the column and
 * scroll its overflow, exactly like its scrolling siblings.
 */
const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

/** Return the declaration block of the first top-level rule for `selector`. */
function ruleBody(selector) {
  const re = new RegExp('(^|})\\s*' + selector.replace(/[.]/g, '\\.') + '\\s*\\{([^}]*)\\}', 'm');
  const m = re.exec(CSS);
  return m ? m[2] : null;
}

describe('top-level view containers own their scroll region', () => {
  test('.upcoming-view fills the flex column and scrolls vertically', () => {
    const body = ruleBody('.upcoming-view');
    expect(body).not.toBeNull();
    expect(body).toMatch(/flex:\s*1\b/);
    expect(body).toMatch(/overflow(-y)?:\s*(auto|scroll)/);
  });

  test.each([
    ['.day-view-scroll'],
    ['.week-view'],
    ['.month-view'],
  ])('%s keeps its scroll contract (no regression from shared tweaks)', (sel) => {
    const body = ruleBody(sel);
    expect(body).not.toBeNull();
    expect(body).toMatch(/flex:\s*1\b/);
    expect(body).toMatch(/overflow(-[xy])?:\s*(auto|scroll)/);
  });
});
