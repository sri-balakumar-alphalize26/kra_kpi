// Home's pause dialog: a Meeting still needs a note, a Team meeting does not.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../api/session', () => ({ getConnection: jest.fn(async () => ({ serverUrl: '' })) }));
jest.mock('../../api/odooApi', () => ({ jsonRpc: jest.fn(), httpUpload: jest.fn() }));

const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react-native');
const kpiActions = require('../../services/kpiActions');
const PauseReasonDialog = require('../PauseReasonDialog').default;

const PEOPLE = [{ id: 7, name: 'Asha', role: 'developer' }];

async function openOnMeeting(onConfirm) {
  jest.spyOn(kpiActions, 'fetchPeople').mockResolvedValue(PEOPLE);
  const utils = render(React.createElement(PauseReasonDialog, {
    visible: true, title: 'Pause Task', subject: 'REQ-001', busy: false,
    onCancel: () => {}, onConfirm,
  }));
  // The quick chip and the dropdown both say "Meeting"; the chip comes first.
  fireEvent.press(utils.getAllByText('Meeting')[0]);
  await waitFor(() => expect(utils.getByText('Asha')).toBeTruthy());
  return utils;
}

afterEach(() => jest.restoreAllMocks());

describe('PauseReasonDialog meeting', () => {
  it('still asks a named meeting what it is about', async () => {
    const onConfirm = jest.fn();
    const { getByText } = await openOnMeeting(onConfirm);
    fireEvent.press(getByText('Confirm Pause'));
    expect(getByText('Say what the meeting is about.')).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('files a Team meeting with no note and no attendees', async () => {
    const onConfirm = jest.fn();
    const { getByText, getByTestId } = await openOnMeeting(onConfirm);
    fireEvent.press(getByTestId('meeting-team'));
    fireEvent.press(getByText('Confirm Pause'));
    expect(onConfirm).toHaveBeenCalledWith({ reason: 'Team meeting', code: 'meeting', meetingWithIds: [] });
  });

  it('keeps a typed note on a Team meeting', async () => {
    const onConfirm = jest.fn();
    const { getByText, getByTestId, getByPlaceholderText } = await openOnMeeting(onConfirm);
    fireEvent.press(getByTestId('meeting-team'));
    fireEvent.changeText(getByPlaceholderText('Optional — saved as “Team meeting”'), 'Sprint review');
    fireEvent.press(getByText('Confirm Pause'));
    expect(onConfirm).toHaveBeenCalledWith({ reason: 'Sprint review', code: 'meeting', meetingWithIds: [] });
  });

  it('picking a person after Team meeting needs a note again', async () => {
    const onConfirm = jest.fn();
    const { getByText, getByTestId, getByPlaceholderText } = await openOnMeeting(onConfirm);
    fireEvent.press(getByTestId('meeting-team'));
    fireEvent.press(getByText('Asha'));
    fireEvent.press(getByText('Confirm Pause'));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.changeText(getByPlaceholderText('Short — e.g. sprint planning'), 'Design sync');
    fireEvent.press(getByText('Confirm Pause'));
    expect(onConfirm).toHaveBeenCalledWith({ reason: 'Design sync', code: 'meeting', meetingWithIds: [7] });
  });
});
