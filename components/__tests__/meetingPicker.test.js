// The Team meeting radio and the people checkboxes are either/or. The icon mock
// in jest.setup.js renders each icon's name as text, which is what these read.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const React = require('react');
const { render, fireEvent } = require('@testing-library/react-native');
const MeetingPicker = require('../MeetingPicker').default;

const PEOPLE = [{ id: 1, name: 'Asha', role: 'developer' }, { id: 2, name: 'Ravi', role: 'client' }];

function Harness({ withTeam = true, onState }) {
  const [picked, setPicked] = React.useState([]);
  const [team, setTeam] = React.useState(false);
  const [query, setQuery] = React.useState('');
  React.useEffect(() => { if (onState) onState({ picked, team }); }, [picked, team, onState]);
  return React.createElement(MeetingPicker, {
    people: PEOPLE, busy: false, query, setQuery, picked, setPicked,
    ...(withTeam ? { team, setTeam } : {}),
  });
}

describe('MeetingPicker', () => {
  it('has no Team meeting row unless the caller asks for one', () => {
    const { queryByText } = render(React.createElement(Harness, { withTeam: false }));
    expect(queryByText('Team meeting')).toBeNull();
  });

  it('Team meeting clears the ticked people, and ticking someone clears it', () => {
    let last;
    const onState = (st) => { last = st; };
    const { getByText, getByTestId } = render(React.createElement(Harness, { onState }));

    fireEvent.press(getByText('Asha'));
    expect(last).toEqual({ picked: [1], team: false });

    fireEvent.press(getByTestId('meeting-team'));
    expect(last).toEqual({ picked: [], team: true });
    expect(getByText('radio-button-on')).toBeTruthy();
    expect(getByText(/no need to pick people or add a note/)).toBeTruthy();

    fireEvent.press(getByText('Ravi'));
    expect(last).toEqual({ picked: [2], team: false });
    expect(getByText('radio-button-off')).toBeTruthy();
  });

  it('a second tap on Team meeting unselects it', () => {
    let last;
    const { getByTestId } = render(React.createElement(Harness, { onState: (st) => { last = st; } }));
    fireEvent.press(getByTestId('meeting-team'));
    fireEvent.press(getByTestId('meeting-team'));
    expect(last.team).toBe(false);
  });
});
